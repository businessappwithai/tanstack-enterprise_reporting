"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EnhancedSchemaMetadata } from "@/lib/nlquery/llama-translator";
import { getLogger } from "@/lib/logging/logger";

interface UseLlamaVoiceOptions {
  onTranscript?: (text: string, isFinal: boolean) => void;
  onSQL?: (sql: string, explanation: string, warnings?: string[]) => void;
  onError?: (error: string) => void;
  generateSQL?: boolean;
  schema?: EnhancedSchemaMetadata;
  userId?: string;
  dataSourceId?: string;
}

interface UseLlamaVoiceState {
  isConnected: boolean;
  isRecording: boolean;
  isTranscribing: boolean;
  transcript: string;
  error: string | null;
}

/**
 * Hook for real-time voice transcription + SQL generation via llama.cpp
 * Captures audio at 16kHz mono PCM16 and streams to WebSocket endpoint
 */
export function useLlamaVoice(options: UseLlamaVoiceOptions = {}) {
  const [state, setState] = useState<UseLlamaVoiceState>({
    isConnected: false,
    isRecording: false,
    isTranscribing: false,
    transcript: "",
    error: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Uint8Array[]>([]);

  // Initialize WebSocket connection
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/voice/ws`);

      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        setState((prev) => ({ ...prev, isConnected: true, error: null }));
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          if (message.type === "transcript") {
            setState((prev) => ({ ...prev, transcript: message.text }));
            options.onTranscript?.(message.text, message.isFinal);
          } else if (message.type === "sql") {
            options.onSQL?.(message.sql, message.explanation, message.warnings);
          } else if (message.type === "error") {
            const error = message.error || "Unknown error";
            setState((prev) => ({ ...prev, error }));
            options.onError?.(error);
          }
        } catch (err) {
          getLogger("voice").note("error", "[useLlamaVoice] Message parse error:", { err: err });
        }
      };

      ws.onerror = () => {
        setState((prev) => ({
          ...prev,
          error: "WebSocket connection error",
        }));
      };

      ws.onclose = () => {
        setState((prev) => ({
          ...prev,
          isConnected: false,
          isRecording: false,
        }));
      };

      wsRef.current = ws;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Connection failed";
      setState((prev) => ({ ...prev, error: msg }));
    }
  }, [options]);

  // Request microphone access and start recording
  const startRecording = useCallback(async () => {
    try {
      setState((prev) => ({ ...prev, error: null, transcript: "" }));

      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        connect();
        // Wait for connection
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      mediaStreamRef.current = stream;

      // Create audio context for PCM16 encoding
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        const inputData = event.inputBuffer.getChannelData(0);
        const pcm16 = encodePCM16(inputData);
        chunksRef.current.push(pcm16);

        // Send chunks every ~500ms (8000 samples at 16kHz)
        if (chunksRef.current.length > 0) {
          const totalBytes = chunksRef.current.reduce((sum, chunk) => sum + chunk.length, 0);
          if (totalBytes > 16000) {
            // ~500ms of audio
            const combined = new Uint8Array(totalBytes);
            let offset = 0;
            for (const chunk of chunksRef.current) {
              combined.set(chunk, offset);
              offset += chunk.length;
            }
            wsRef.current?.send(combined);
            chunksRef.current = [];
          }
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      setState((prev) => ({ ...prev, isRecording: true }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Microphone access denied";
      setState((prev) => ({ ...prev, error: msg }));
    }
  }, [connect]);

  // Stop recording and transcribe
  const stopRecording = useCallback(() => {
    if (!mediaStreamRef.current) return;

    // Stop all tracks
    mediaStreamRef.current.getTracks().forEach((track) => {
      track.stop();
    });
    mediaStreamRef.current = null;

    // Disconnect audio processor
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    setState((prev) => ({ ...prev, isRecording: false, isTranscribing: true }));

    // Send any remaining audio chunks
    if (chunksRef.current.length > 0) {
      const totalBytes = chunksRef.current.reduce((sum, chunk) => sum + chunk.length, 0);
      const combined = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunksRef.current) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      wsRef.current?.send(combined);
      chunksRef.current = [];
    }

    // Send transcription request
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "transcribe",
          generateSQL: options.generateSQL,
          schema: options.schema,
          userId: options.userId,
          dataSourceId: options.dataSourceId,
        })
      );
    }

    // Reset transcribing state after a delay
    setTimeout(() => {
      setState((prev) => ({ ...prev, isTranscribing: false }));
    }, 1000);
  }, [options]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => {
          track.stop();
        });
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  return {
    ...state,
    connect,
    startRecording,
    stopRecording,
  };
}

/**
 * Encode Float32 PCM audio to PCM16 (signed 16-bit)
 */
function encodePCM16(float32Samples: Float32Array): Uint8Array {
  const buffer = new DataView(new ArrayBuffer(float32Samples.length * 2));
  let offset = 0;

  for (let i = 0; i < float32Samples.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Samples[i]));
    buffer.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Uint8Array(buffer.buffer);
}
