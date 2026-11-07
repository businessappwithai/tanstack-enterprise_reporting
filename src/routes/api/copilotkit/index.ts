import { createFileRoute } from "@tanstack/react-router";
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
    // Use AI_NL2SQL_BASE_URL (headroom proxy) if set, otherwise fall back to MASTRA_URL/v1
    const aiBaseURL =
      process.env.AI_NL2SQL_BASE_URL ||
      (process.env.MASTRA_URL ? `${process.env.MASTRA_URL}/v1` : "http://localhost:4111/v1");
    const baseURL = aiBaseURL.endsWith("/v1") ? aiBaseURL.slice(0, -3) : aiBaseURL;
    const apiKey = process.env.AI_NL2SQL_API_KEY ?? process.env.LLAMA_REASONING_API_KEY ?? "none";
    const model = process.env.AI_NL2SQL_MODEL ?? process.env.LLAMA_REASONING_MODEL ?? "qwen3.6";

    const openai = new OpenAI({
      baseURL: aiBaseURL,
      apiKey,
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

export const Route = createFileRoute("/api/copilotkit/")({
  server: {
    handlers: {
      GET: withApiHandler("/api/copilotkit/", async ({ request }) => {
        const refusal = await requireSession(request);
        if (refusal) return refusal;
        return getHandler().handleRequest(request);
      }),
      POST: withApiHandler("/api/copilotkit/", async ({ request }) => {
        const refusal = await requireSession(request);
        if (refusal) return refusal;
        return getHandler().handleRequest(request);
      }),
    },
  },
});
