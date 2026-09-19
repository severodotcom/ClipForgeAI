import { auth } from "@/lib/auth";
import { retryVideo } from "@/lib/retry";
import { checkRateLimit, rateLimitKey, rateLimitResponse, RATE_LIMIT_RULES } from "@/lib/rate-limit";
import { headers } from "next/headers";

export async function POST(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]/videos/[videoId]/retry">
) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return Response.json(
      { error: "Não autenticado" },
      { status: 401 }
    );
  }

  // P2a: rate limit antes de qualquer ownership/query/transação — inclusive
  // antes da própria retryVideo, que já é atômica contra corrida mas não
  // limita a frequência de tentativas.
  const rateDecision = checkRateLimit(
    rateLimitKey("video-retry", session.user.id),
    RATE_LIMIT_RULES.VIDEO_RETRY
  );

  if (!rateDecision.allowed) {
    return rateLimitResponse(rateDecision);
  }

  const { id: projectId, videoId } = await params;

  const result = await retryVideo(projectId, videoId, session.user.id);

  switch (result.outcome) {
    case "not_found":
      return Response.json(
        { error: "Vídeo não encontrado" },
        { status: 404 }
      );

    case "not_failed":
      return Response.json(
        {
          error: "Somente vídeos com falha podem ser repetidos.",
          code: "NOT_FAILED",
          status: result.video.status,
        },
        { status: 409 }
      );

    case "missing_upload_data":
      return Response.json(
        {
          error:
            "Não é possível repetir: o upload original falhou antes de o vídeo ser processado. Envie o vídeo novamente.",
          code: "MISSING_UPLOAD_DATA",
        },
        { status: 409 }
      );

    case "started":
      return Response.json(result.video, { status: 200 });
  }
}
