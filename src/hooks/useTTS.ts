"use client";

import { useCallback, useRef, useState } from "react";
import { getLogger } from "@/lib/logging/logger";

interface UseTTSState {
  isSpeaking: boolean;
  error: string | null;
}

/**
 * Hook for text-to-speech synthesis via Qwen3-TTS
 * Fetches audio from /api/voice/synthesize and plays via Web Audio API
 */
export function useTTS() {
  const [state, setState] = useState<UseTTSState>({
    isSpeaking: false,
    error: null,
  });

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  const speak = useCallback(async (text: string) => {
    try {
      setState({ isSpeaking: true, error: null });

      // Fetch audio from server
      const response = await fetch("/api/voice/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        throw new Error(`TTS failed: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();

      // Initialize audio context if needed
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }

      const audioContext = audioContextRef.current;

      // Resume context if suspended (common on mobile)
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      // Decode audio
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

      // Stop any currently playing audio
      if (sourceRef.current) {
        sourceRef.current.stop();
      }

      // Create source and play
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);

      source.onended = () => {
        setState((prev) => ({ ...prev, isSpeaking: false }));
      };

      source.start(0);
      sourceRef.current = source;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "TTS error";
      setState({ isSpeaking: false, error: msg });
      getLogger("voice").note("error", "[useTTS] Error:", { err: error });
    }
  }, []);

  const stop = useCallback(() => {
    if (sourceRef.current) {
      try {
        sourceRef.current.stop();
      } catch {
        // Already stopped
      }
      sourceRef.current = null;
    }
    setState({ isSpeaking: false, error: null });
  }, []);

  return {
    ...state,
    speak,
    stop,
  };
}
