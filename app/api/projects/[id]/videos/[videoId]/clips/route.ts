import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateClip } from "@/lib/clips";
import { getOwnedVideo } from "@/lib/ownership";
import { checkQuota, getPeriodStart, lockUserForQuota, recordUsage, type QuotaCheckResult } from "@/lib/usage";
import { UsageType } from "@prisma/client";
import { headers } from "next/headers";

const MAX_TITLE_LENGTH = 200;
const MAX_REASON_LENGTH = 500;

/** Thrown inside the locked transaction to trigger a rollback when the user
 * is already at their CLIP_GENERATED quota for this period. Only the
 * initial creation of a Clip consumes quota — regenerating an existing
 * Clip via PATCH (edit) is free and never goes through this check, since
 * it reuses the same idempotencyKey (CLIP_GENERATED:<clipId>) and would be
 * a no-op on the ledger even if it did. */
class QuotaExceededError extends Error {
  constructor(public readonly quota: QuotaCheckResult) {
    super("QUOTA_EXCEEDED");
  }
}

export async function POST(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]/videos/[videoId]/clips">
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

  const { id: projectId, videoId } = await params;

  const video = await getOwnedVideo(projectId, videoId, session.user.id);

  if (!video) {
    return Response.json(
      { error: "Vídeo não encontrado" },
      { status: 404 }
    );
  }

  const body = await request.json();
  const startTime = Number(body.startTime);
  const endTime = Number(body.endTime);
  const title =
    typeof body.title === "string"
      ? body.title.trim().slice(0, MAX_TITLE_LENGTH)
      : null;
  const reason =
    typeof body.reason === "string"
      ? body.reason.trim().slice(0, MAX_REASON_LENGTH)
      : null;
  const score =
    typeof body.score === "number" && Number.isFinite(body.score)
      ? Math.min(100, Math.max(0, body.score))
      : null;

  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    startTime < 0 ||
    endTime <= startTime
  ) {
    return Response.json(
      { error: "Intervalo de tempo inválido" },
      { status: 400 }
    );
  }

  if (video.duration != null && endTime > video.duration) {
    return Response.json(
      { error: "O fim do clipe não pode ultrapassar a duração do vídeo" },
      { status: 400 }
    );
  }

  let clip;
  try {
    clip = await prisma.$transaction(async (tx) => {
      await lockUserForQuota(session.user.id, tx);

      const quota = await checkQuota(session.user.id, UsageType.CLIP_GENERATED, 1, tx);

      if (!quota.allowed) {
        throw new QuotaExceededError(quota);
      }

      const created = await tx.clip.create({
        data: {
          videoId,
          startTime,
          endTime,
          title: title || null,
          reason: reason || null,
          score,
          status: "PENDING",
        },
      });

      await recordUsage(
        {
          userId: session.user.id,
          type: UsageType.CLIP_GENERATED,
          amount: 1,
          periodStart: getPeriodStart(),
          idempotencyKey: `CLIP_GENERATED:${created.id}`,
          videoId,
          clipId: created.id,
        },
        tx
      );

      return created;
    });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return Response.json(
        {
          error: "Limite de clipes do plano atingido neste período.",
          code: "QUOTA_EXCEEDED",
          usage: error.quota.used,
          limit: error.quota.limit,
        },
        { status: 403 }
      );
    }

    console.error(`Falha ao verificar quota/criar clipe para o vídeo ${videoId}:`, error);

    return Response.json(
      { error: "Falha ao criar o clipe" },
      { status: 500 }
    );
  }

  generateClip(clip.id).catch((error) => {
    console.error(`Falha ao iniciar geração do clipe ${clip.id}:`, error);
  });

  return Response.json(clip, { status: 201 });
}
