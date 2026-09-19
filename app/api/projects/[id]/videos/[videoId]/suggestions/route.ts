import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOwnedVideo } from "@/lib/ownership";
import { peekCache, runAnalysis, type TranscriptSegment } from "@/lib/analysis";
import { checkQuota, getPeriodStart, recordUsage } from "@/lib/usage";
import { checkRateLimit, rateLimitKey, rateLimitResponse, RATE_LIMIT_RULES } from "@/lib/rate-limit";
import { UsageType } from "@prisma/client";
import { headers } from "next/headers";

export async function POST(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]/videos/[videoId]/suggestions">
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

  // P2a: rate limit antes de ownership/query/quota — inclusive antes do
  // peekCache, que já é "network-free e cost-free" mas ainda assim é uma
  // query no banco.
  const rateDecision = checkRateLimit(
    rateLimitKey("ai-suggestions", session.user.id),
    RATE_LIMIT_RULES.AI_SUGGESTIONS
  );

  if (!rateDecision.allowed) {
    return rateLimitResponse(rateDecision);
  }

  const { id: projectId, videoId } = await params;

  const video = await getOwnedVideo(projectId, videoId, session.user.id);

  if (!video) {
    return Response.json(
      { error: "Vídeo não encontrado" },
      { status: 404 }
    );
  }

  const transcription = await prisma.transcription.findUnique({
    where: { videoId },
  });

  if (!transcription) {
    return Response.json(
      { error: "Vídeo ainda não foi transcrito" },
      { status: 409 }
    );
  }

  const transcript = {
    videoId,
    duration: video.duration,
    text: transcription.text,
    segments: transcription.segments as unknown as TranscriptSegment[],
  };

  try {
    // Cache lookup first — network-free and cost-free. A hit is returned
    // immediately, even if the user's monthly AI_ANALYSIS quota is already
    // exhausted: this result was already produced (and paid for) earlier,
    // reusing it costs nothing and consumes no new quota.
    const cachePeek = await peekCache(transcript);

    if (cachePeek.cacheHit) {
      return Response.json(cachePeek.result);
    }

    // Confirmed miss on a provider that actually costs money (openai) —
    // check quota strictly *before* triggering the real analysis, and
    // *without* holding any Postgres lock across it (the call inside
    // runAnalysis below can take several seconds; see openai-analyzer.ts).
    if (cachePeek.requiresQuotaCheck) {
      const quota = await checkQuota(session.user.id, UsageType.AI_ANALYSIS, 1);

      if (!quota.allowed) {
        return Response.json(
          {
            error: "Limite de análises de IA do plano atingido neste período.",
            code: "QUOTA_EXCEEDED",
            usage: quota.used,
            limit: quota.limit,
          },
          { status: 403 }
        );
      }
    }

    const result = await runAnalysis(transcript);

    // Only a genuine cache miss that produced a new AnalysisCache row
    // consumes AI_ANALYSIS — a cache hit (result.cacheHit) or a provider
    // without caching (analysisCacheId null, e.g. mock) never reaches
    // here. idempotencyKey is tied to the AnalysisCache row's own id, not
    // videoId alone, so two concurrent requests for the same transcript
    // resolve to the same row (saveAnalysisCache upserts) and therefore
    // the same key — recordUsage's unique-constraint upsert collapses
    // them into exactly one UsageRecord. This does NOT prevent both
    // requests from having already called the OpenAI API for real: that
    // cost, if it happens, happens twice — only the ledger stays correct.
    if (!result.cacheHit && result.analysisCacheId) {
      try {
        await recordUsage({
          userId: session.user.id,
          type: UsageType.AI_ANALYSIS,
          amount: 1,
          periodStart: getPeriodStart(),
          idempotencyKey: `AI_ANALYSIS:${result.analysisCacheId}`,
          analysisCacheId: result.analysisCacheId,
          promptTokens: result.usage?.promptTokens ?? undefined,
          completionTokens: result.usage?.completionTokens ?? undefined,
          totalTokens: result.usage?.totalTokens ?? undefined,
        });
      } catch (usageError) {
        // Deliberately not rethrown: the analysis itself succeeded and is
        // already cached, so the user still gets a correct response. A
        // failure here means undercounting (this analysis silently doesn't
        // count against quota) — the same "safe direction" already
        // accepted for VIDEO_UPLOAD/TRANSCRIPTION_MINUTES/CLIP_GENERATED.
        // No automatic retry at this stage — logged loudly so it's not
        // silently lost.
        console.error(
          `[AI_ANALYSIS] Falha ao registrar UsageRecord para analysisCacheId=${result.analysisCacheId} (vídeo ${videoId}):`,
          usageError
        );
      }
    }

    return Response.json(result);
  } catch (error) {
    console.error(`Falha ao gerar sugestões para o vídeo ${videoId}:`, error);

    return Response.json(
      { error: "Falha ao gerar sugestões" },
      { status: 502 }
    );
  }
}
