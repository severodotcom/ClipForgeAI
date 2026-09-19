import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAudioDuration } from "@/lib/ffmpeg";
import { getVideoAbsolutePath, saveVideoFile } from "@/lib/storage";
import { transcribeVideo } from "@/lib/transcription";
import { checkQuota, getPeriodStart, lockUserForQuota, recordUsage, type QuotaCheckResult } from "@/lib/usage";
import { checkRateLimit, rateLimitKey, rateLimitResponse, RATE_LIMIT_RULES } from "@/lib/rate-limit";
import { UsageType } from "@prisma/client";
import { headers } from "next/headers";

const MAX_VIDEO_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

/** Thrown inside the locked transaction to trigger a rollback when the
 * user is already at their VIDEO_UPLOAD quota for this period. Carries the
 * quota snapshot so the catch block can build the 403 response without a
 * second query. */
class QuotaExceededError extends Error {
  constructor(public readonly quota: QuotaCheckResult) {
    super("QUOTA_EXCEEDED");
  }
}

async function getOwnedProject(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });

  if (!project || project.userId !== userId) {
    return null;
  }

  return project;
}

export async function POST(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]/videos">
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

  // P2a: rate limit checado logo após autenticar, antes de qualquer
  // ownership/query/quota/transação — uma requisição que estoura o limite
  // nunca chega a tocar o banco.
  const rateDecision = checkRateLimit(
    rateLimitKey("upload", session.user.id),
    RATE_LIMIT_RULES.VIDEO_UPLOAD
  );

  if (!rateDecision.allowed) {
    return rateLimitResponse(rateDecision);
  }

  const { id: projectId } = await params;

  const project = await getOwnedProject(projectId, session.user.id);

  if (!project) {
    return Response.json(
      { error: "Projeto não encontrado" },
      { status: 404 }
    );
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return Response.json(
      { error: "Nenhum arquivo de vídeo enviado" },
      { status: 400 }
    );
  }

  if (!file.type.startsWith("video/")) {
    return Response.json(
      { error: "O arquivo enviado precisa ser um vídeo" },
      { status: 400 }
    );
  }

  if (file.size > MAX_VIDEO_SIZE_BYTES) {
    return Response.json(
      { error: "O arquivo excede o tamanho máximo permitido (2GB)" },
      { status: 400 }
    );
  }

  let video;
  try {
    video = await prisma.$transaction(async (tx) => {
      await lockUserForQuota(session.user.id, tx);

      const quota = await checkQuota(session.user.id, UsageType.VIDEO_UPLOAD, 1, tx);

      if (!quota.allowed) {
        throw new QuotaExceededError(quota);
      }

      const created = await tx.video.create({
        data: {
          projectId,
          originalFilename: file.name,
          status: "UPLOADING",
        },
      });

      await recordUsage(
        {
          userId: session.user.id,
          type: UsageType.VIDEO_UPLOAD,
          amount: 1,
          periodStart: getPeriodStart(),
          idempotencyKey: `VIDEO_UPLOAD:${created.id}`,
          videoId: created.id,
        },
        tx
      );

      return created;
    });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return Response.json(
        {
          error: "Limite de vídeos do plano atingido neste período.",
          code: "QUOTA_EXCEEDED",
          usage: error.quota.used,
          limit: error.quota.limit,
        },
        { status: 403 }
      );
    }

    console.error(`Falha ao verificar quota/criar vídeo para o projeto ${projectId}:`, error);

    return Response.json(
      { error: "Falha ao criar o vídeo" },
      { status: 500 }
    );
  }

  try {
    const storagePath = await saveVideoFile({
      projectId,
      videoId: video.id,
      file,
    });

    let duration: number;
    try {
      duration = await getAudioDuration(getVideoAbsolutePath(storagePath));
    } catch (probeError) {
      console.error(`Falha ao determinar a duração do vídeo ${video.id}:`, probeError);

      await prisma.video.update({
        where: { id: video.id },
        data: { storagePath, status: "FAILED" },
      });

      return Response.json(
        { error: "Falha ao processar o vídeo enviado" },
        { status: 500 }
      );
    }

    const minutes = Math.ceil(duration / 60);

    // Quota de minutos verificada e reservada aqui — antes do Whisper rodar
    // — dentro da mesma trava usada para VIDEO_UPLOAD, pelo mesmo motivo:
    // duas transcrições concorrentes não podem ambas ver saldo suficiente e
    // ambas passarem. Se não couber, o vídeo já enviado fica marcado
    // QUOTA_EXCEEDED (upload em si não é desfeito) e a transcrição nunca é
    // iniciada — nenhum custo de Whisper, nenhum minuto é cobrado.
    const finalVideo = await prisma.$transaction(async (tx) => {
      await lockUserForQuota(session.user.id, tx);

      const minutesQuota = await checkQuota(
        session.user.id,
        UsageType.TRANSCRIPTION_MINUTES,
        minutes,
        tx
      );

      if (!minutesQuota.allowed) {
        return tx.video.update({
          where: { id: video.id },
          data: { storagePath, duration, status: "QUOTA_EXCEEDED" },
        });
      }

      const updated = await tx.video.update({
        where: { id: video.id },
        data: { storagePath, duration, status: "UPLOADED" },
      });

      await recordUsage(
        {
          userId: session.user.id,
          type: UsageType.TRANSCRIPTION_MINUTES,
          amount: minutes,
          periodStart: getPeriodStart(),
          idempotencyKey: `TRANSCRIPTION_MINUTES:${video.id}`,
          videoId: video.id,
        },
        tx
      );

      return updated;
    });

    if (finalVideo.status === "UPLOADED") {
      transcribeVideo(finalVideo.id).catch((error) => {
        console.error(`Falha ao iniciar transcrição do vídeo ${finalVideo.id}:`, error);
      });
    }

    return Response.json(finalVideo, { status: 201 });
  } catch (error) {
    console.error(`Falha ao processar upload do vídeo ${video.id}:`, error);

    await prisma.video.update({
      where: { id: video.id },
      data: { status: "FAILED" },
    });

    return Response.json(
      { error: "Falha ao salvar o vídeo" },
      { status: 500 }
    );
  }
}

export async function GET(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]/videos">
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

  const { id: projectId } = await params;

  const project = await getOwnedProject(projectId, session.user.id);

  if (!project) {
    return Response.json(
      { error: "Projeto não encontrado" },
      { status: 404 }
    );
  }

  const videos = await prisma.video.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: {
      transcription: true,
      clips: { orderBy: { createdAt: "desc" } },
    },
  });

  return Response.json(videos);
}
