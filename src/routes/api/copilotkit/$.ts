import { createFileRoute } from "@tanstack/react-router";
import { getLogger } from "@/lib/logging/logger";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { auth } from "@/lib/auth/config";
import {
  CopilotRuntime,
  OpenAIAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { createOpenAI } from "@ai-sdk/openai";
import OpenAI from "openai";

class OpenAIChatAdapter extends OpenAIAdapter {
  private _chatModel: string;
  private _chatBaseURL: string;
  private _chatApiKey: string;

  constructor(params: { openai: OpenAI; model: string }) {
    super(params);
    this._chatModel = params.model;
    this._chatBaseURL = params.openai.baseURL;
    this._chatApiKey = params.openai.apiKey as string;
  }

  getLanguageModel() {
    const provider = createOpenAI({
      baseURL: this._chatBaseURL,
      apiKey: this._chatApiKey,
    });
    return provider.chat(this._chatModel);
  }
}

let _handler: { handleRequest: (req: Request) => Response | Promise<Response> } | null = null;

function getHandler() {
  if (!_handler) {
    const aiBaseURL =
      process.env.AI_NL2SQL_BASE_URL ||
      (process.env.MASTRA_URL ? `${process.env.MASTRA_URL}/v1` : "http://localhost:4111/v1");
    const mastraUrl = aiBaseURL.endsWith("/v1") ? aiBaseURL.slice(0, -3) : aiBaseURL;
    const apiKey = process.env.AI_NL2SQL_API_KEY ?? process.env.LLAMA_REASONING_API_KEY ?? "none";
    const model = process.env.AI_NL2SQL_MODEL ?? process.env.LLAMA_REASONING_MODEL ?? "qwen3.6";

    const openai = new OpenAI({
      baseURL: aiBaseURL,
      apiKey,
      timeout: 120_000,
    });

    const runtime = new CopilotRuntime();
    _handler = copilotRuntimeNextJSAppRouterEndpoint({
      runtime,
      serviceAdapter: new OpenAIChatAdapter({ openai, model }),
      endpoint: "/api/copilotkit",
    });
  }
  return _handler;
}

async function convertToWav(inputBlob: Blob): Promise<Blob> {
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { unlink } = await import("node:fs/promises");

  const id = crypto.randomUUID();
  const inputPath = join(tmpdir(), `stt-in-${id}`);
  const outputPath = join(tmpdir(), `stt-out-${id}.wav`);

  await Bun.write(inputPath, inputBlob);
  try {
    const proc = Bun.spawn(
      ["ffmpeg", "-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", outputPath],
      { stdout: "ignore", stderr: "ignore" }
    );
    const code = await proc.exited;
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    const wavFile = Bun.file(outputPath);
    const wavBlob = new Blob([await wavFile.arrayBuffer()], { type: "audio/wav" });
    return wavBlob;
  } finally {
    unlink(inputPath).catch(() => {});
    unlink(outputPath).catch(() => {});
  }
}

async function handleTranscribe(request: Request): Promise<Response> {
  const mastraUrl = process.env.MASTRA_URL || "http://localhost:4111";
  try {
    const formData = await request.formData();
    const audioFile = formData.get("file") || formData.get("audio");
    if (!audioFile || !(audioFile instanceof Blob)) {
      return new Response(JSON.stringify({ text: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const originalName = audioFile instanceof File ? audioFile.name : "recording";
    const isWav = originalName.endsWith(".wav") || audioFile.type === "audio/wav";
    let wavBlob: Blob;
    try {
      wavBlob = isWav ? audioFile : await convertToWav(audioFile);
    } catch (convErr) {
      recordFailure(convErr, "[CopilotKit Transcribe] Audio conversion failed:");
      return new Response(JSON.stringify({ text: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const proxyForm = new FormData();
    proxyForm.append("file", wavBlob, "audio.wav");
    proxyForm.append("response_format", "json");

    const res = await fetch(`${mastraUrl}/v1/audio/transcriptions`, {
      method: "POST",
      body: proxyForm,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      getLogger("voice").event("voice.transcription.failed", { reason: `Mastra STT answered ${res.status}` });
      return new Response(JSON.stringify({ text: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await res.json();
    const text = (result.text || "").trim();

    return new Response(JSON.stringify({ text: text || "" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    recordFailure(error, "[CopilotKit Transcribe] Error:");
    return new Response(JSON.stringify({ text: "" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function handleTts(request: Request): Promise<Response> {
  const mastraUrl = process.env.MASTRA_URL || "http://localhost:4111";
  try {
    const body = await request.json();

    const res = await fetch(`${mastraUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      return new Response(JSON.stringify({ error: `TTS failed: ${errText}` }), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const audioData = await res.arrayBuffer();
    return new Response(audioData, {
      status: 200,
      headers: { "Content-Type": res.headers.get("Content-Type") || "audio/mpeg" },
    });
  } catch (error) {
    recordFailure(error, "[CopilotKit TTS] Error:");
    return new Response(JSON.stringify({ error: "TTS service unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Every handler below requires a session.
 *
 * A security review found this route reachable with no authentication at all —
 * an open proxy to the configured model, using the server's own API key. Anyone
 * who could reach the origin could spend the budget, address the model
 * directly, and (on the transcribe path) have arbitrary uploaded bytes written
 * to disk and fed to ffmpeg.
 *
 * It is not a public surface. It is the sidebar's backend, and the sidebar is
 * behind `_authed`.
 */
async function requireSession(request: Request): Promise<Response | null> {
  const session = await auth(request);
  if (!session?.user) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

export const Route = createFileRoute("/api/copilotkit/$")({
  server: {
    handlers: {
      GET: withApiHandler("/api/copilotkit/$", async ({ request }) => {
        const refusal = await requireSession(request);
        if (refusal) return refusal;

        const url = new URL(request.url);
        if (url.pathname.includes("/threads")) {
          return new Response(JSON.stringify({ threads: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return getHandler().handleRequest(request);
      }),
      POST: withApiHandler("/api/copilotkit/$", async ({ request }) => {
        const refusal = await requireSession(request);
        if (refusal) return refusal;

        const url = new URL(request.url);
        if (url.pathname.endsWith("/transcribe")) {
          return handleTranscribe(request);
        }
        if (url.pathname.endsWith("/tts")) {
          return handleTts(request);
        }
        if (url.pathname.includes("/threads")) {
          return new Response(JSON.stringify({ threadId: crypto.randomUUID() }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return getHandler().handleRequest(request);
      }),
    },
  },
});
