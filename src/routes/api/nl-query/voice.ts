import { createFileRoute } from "@tanstack/react-router";
import { getLogger } from "@/lib/logging/logger";
import { recordFailure } from "@/lib/logging/request-context";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { json } from "@/lib/server/response";
import { readSessionToken, verifySession } from "@/lib/auth/session";
import { transcribeAudio } from "@/lib/voice/qwen-asr";

async function getSession(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = readSessionToken(cookie);
  if (!token) return null;
  return verifySession(token);
}

export const Route = createFileRoute("/api/nl-query/voice")({
  server: {
    handlers: {
      POST: withApiHandler("/api/nl-query/voice", async ({ request }: { request: Request }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json({ success: false, error: "Unauthorized" }, { status: 401 });
          }

          // Parse audio from the incoming multipart/form-data
          let formData: FormData;
          try {
            formData = await request.formData();
          } catch {
            return json({ success: false, error: "Expected multipart/form-data with audio field" });
          }

          const audioEntry = formData.get("audio");
          if (!audioEntry || !(audioEntry instanceof Blob)) {
            return json({ success: false, error: "No audio data in request" });
          }

          // Transcribe using llama.cpp Qwen3-ASR
          const text = await transcribeAudio(audioEntry);

          if (!text) {
            getLogger("voice").event("voice.transcription.failed", { reason: "the transcription was empty" });
            return json({
              success: false,
              error: "Transcription failed. Ensure Qwen3-ASR is available on llama.cpp server.",
            });
          }

          if (!text) {
            return json({
              success: false,
              error: "No speech detected — try speaking more clearly",
            });
          }

          return json({ success: true, text });
        } catch (error) {
          recordFailure(error, "[Voice] Error:");
          const msg = error instanceof Error ? error.message : "Transcription failed";
          return json({ success: false, error: msg });
        }
      }),
    },
  },
});
