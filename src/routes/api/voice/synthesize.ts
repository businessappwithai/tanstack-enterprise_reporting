import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { auth } from "@/lib/auth/config";
import { synthesizeSpeech } from "@/lib/voice/qwen-tts";

export const Route = createFileRoute("/api/voice/synthesize")({
  server: {
    handlers: {
      POST: withApiHandler("/api/voice/synthesize", async ({ request }: { request: Request }) => {
        try {
          /*
           * Authenticated, which it was not.
           *
           * A security review found this route reachable with no session at
           * all. It is not a public surface: it spends the server's own
           * resources — and, on the transcribe and copilot paths, the
           * configured model's API key — on behalf of whoever can reach the
           * origin.
           */
          const session = await auth(request);
          if (!session?.user) {
            return new Response(JSON.stringify({ error: "Not authenticated" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            });
          }

          const body = (await request.json()) as { text?: string };

          if (!body.text || typeof body.text !== "string") {
            return new Response(JSON.stringify({ error: "Text field is required" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const audioBuffer = await synthesizeSpeech(body.text);

          if (!audioBuffer) {
            return new Response(JSON.stringify({ error: "TTS synthesis failed" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }

          return new Response(audioBuffer, {
            status: 200,
            headers: { "Content-Type": "audio/mpeg" },
          });
        } catch (error) {
          recordFailure(error, "[Synthesize] Error:");
          return new Response(JSON.stringify({ error: "Internal server error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }),
    },
  },
});
