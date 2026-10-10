import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOwnedVideo } from "@/lib/ownership";
import { deleteClipFile, deleteVideoFile } from "@/lib/storage";
import { checkRateLimit, rateLimitKey, rateLimitResponse, RATE_LIMIT_RULES } from "@/lib/rate-limit";
import type { VideoStatus } from "@prisma/client";
import { headers } from "next/headers";

// Mesmo conjunto de status "em andamento" usado pela reconciliação
// (lib/reconciliation.ts) — um vídeo nesses estados está sendo processado
// por um job de Whisper/ffmpeg ativo (ou que pode estar ativo; não há
// cancelamento) e não pode ser excluído com segurança.
const BLOCKED_VIDEO_STATUSES: VideoStatus[] = ["TRANSCRIBING", "ANALYZING", "GENERATING"];

export async function DELETE(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]/videos/[videoId]">
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

  // P2g: rate limit antes de ownership/storage/banco — mesmo padrão de
  // upload/retry/clip-generation (P2a).
  const rateDecision = checkRateLimit(
    rateLimitKey("video-delete", session.user.id),
    RATE_LIMIT_RULES.VIDEO_DELETE
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

  if (BLOCKED_VIDEO_STATUSES.includes(video.status)) {
    return Response.json(
      {
        error: "O vídeo está em processamento e não pode ser excluído agora.",
        code: "VIDEO_PROCESSING",
      },
      { status: 409 }
    );
  }

  const clips = await prisma.clip.findMany({
    where: { videoId },
    select: { outputPath: true },
  });

  const clipPaths = clips
    .map((clip) => clip.outputPath)
    .filter((outputPath): outputPath is string => outputPath != null);

  try {
    if (video.storagePath) {
      await deleteVideoFile(video.storagePath);
    }

    for (const clipPath of clipPaths) {
      await deleteClipFile(clipPath);
    }
  } catch (error) {
    // Erro real de filesystem (não ENOENT) — aborta antes de tocar o
    // banco, pelo mesmo motivo do DELETE de projeto.
    console.error(`Falha ao remover arquivos físicos do vídeo ${videoId}:`, error);

    return Response.json(
      { error: "Falha ao remover os arquivos do vídeo" },
      { status: 500 }
    );
  }

  // Exclusão condicional e atômica — mesmo padrão de lib/retry.ts
  // (updateMany com o status no próprio WHERE): se o status mudou para um
  // dos estados bloqueados entre a checagem acima e este delete (ex: um
  // retry concorrente iniciou o processamento enquanto os arquivos já
  // estavam sendo removidos), count fica 0 e a linha NÃO é apagada — não é
  // um SELECT seguido de um DELETE incondicional.
  const result = await prisma.video.deleteMany({
    where: {
      id: videoId,
      projectId,
      status: { notIn: BLOCKED_VIDEO_STATUSES },
    },
  });

  if (result.count === 0) {
    const stillExists = await prisma.video.findUnique({ where: { id: videoId } });

    if (!stillExists) {
      // Perdeu a corrida para outra exclusão concorrente (ex: duplo
      // clique) — já não existe, resultado final é o mesmo que o desta
      // chamada teria produzido.
      return Response.json(
        { error: "Vídeo não encontrado" },
        { status: 404 }
      );
    }

    // Perdeu a corrida para uma transição de status (ex: retry concorrente
    // iniciou o processamento) depois que os arquivos já tinham sido
    // removidos nesta chamada. Caso raro e não coberto por um mecanismo de
    // reconciliação dedicado — ver auditoria P2g, seção "Riscos residuais".
    console.error(
      `Vídeo ${videoId} mudou para um status de processamento durante a exclusão; arquivos já removidos, linha mantida.`
    );

    return Response.json(
      {
        error: "O vídeo entrou em processamento durante a exclusão. Tente novamente.",
        code: "VIDEO_PROCESSING",
      },
      { status: 409 }
    );
  }

  // Cascade do PostgreSQL remove Transcription, Clip e AnalysisCache
  // associados — não reimplementado aqui.
  return new Response(null, { status: 204 });
}
