import { createFileRoute } from "@tanstack/react-router";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { auth } from "@/lib/auth/config";
import { transcribeAudio } from "@/lib/voice/qwen-asr";

export const Route = createFileRoute("/api/voice/transcribe")({
  server: {
    handlers: {
      POST: withApiHandler("/api/voice/transcribe", async ({ request }: { request: Request }) => {
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

          const formData = await request.formData();
          const audioFile = formData.get("audio") as File | null;

          if (!audioFile) {
            return new Response(JSON.stringify({ error: "No audio file provided" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const blob = new Blob([await audioFile.arrayBuffer()], { type: audioFile.type });
          const text = await transcribeAudio(blob);

          if (!text) {
            return new Response(JSON.stringify({ error: "Transcription failed" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }

          return new Response(JSON.stringify({ success: true, text }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          recordFailure(error, "[Transcribe] Error:");
          return new Response(JSON.stringify({ error: "Internal server error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }),
    },
  },
});
