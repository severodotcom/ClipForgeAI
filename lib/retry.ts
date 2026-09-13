import { prisma } from "@/lib/prisma";
import { getOwnedVideo, getOwnedClip } from "@/lib/ownership";
import { transcribeVideo } from "@/lib/transcription";
import { generateClip } from "@/lib/clips";
import type { Clip, Video } from "@prisma/client";

// Retry manual de Video/Clip que terminaram em FAILED (P1e). Não consome
// quota de novo: VIDEO_UPLOAD e TRANSCRIPTION_MINUTES (vídeo) e
// CLIP_GENERATED (clipe) já foram reservados/cobrados quando o recurso foi
// criado com sucesso pela primeira vez — reprocessar não é um novo evento
// de negócio, é repetir um trabalho que já foi pago. Ver lib/usage.ts para
// as idempotencyKeys originais (não são tocadas aqui).
//
// Proteção contra corrida (duas chamadas concorrentes de retry, ou um
// retry contra uma operação que na verdade ainda está em andamento): a
// transição de status é um único `updateMany` com `status: "FAILED"` no
// próprio `where` — não um SELECT seguido de UPDATE em código de aplicação.
// Isso é atômico no Postgres: das N chamadas concorrentes que passarem por
// aqui para o mesmo recurso, no máximo uma terá `count === 1`; as demais
// verão `count === 0` porque a linha já não estava mais FAILED no momento
// em que a própria UPDATE foi avaliada.
export type RetryVideoResult =
  | { outcome: "not_found" }
  | { outcome: "not_failed"; video: Video }
  | { outcome: "missing_upload_data"; video: Video }
  | { outcome: "started"; video: Video };

export type RetryClipResult =
  | { outcome: "not_found" }
  | { outcome: "not_failed"; clip: Clip }
  | { outcome: "started"; clip: Clip };

export async function retryVideo(
  projectId: string,
  videoId: string,
  userId: string
): Promise<RetryVideoResult> {
  const video = await getOwnedVideo(projectId, videoId, userId);

  if (!video) {
    return { outcome: "not_found" };
  }

  if (video.status !== "FAILED") {
    return { outcome: "not_failed", video };
  }

  // Sem storagePath/duration, o vídeo nunca chegou a ser processado (ex:
  // ffprobe falhou antes de UPLOADED) — não há nada para retomar, o
  // usuário precisa reenviar o arquivo.
  if (!video.storagePath || video.duration == null) {
    return { outcome: "missing_upload_data", video };
  }

  const result = await prisma.video.updateMany({
    where: { id: videoId, status: "FAILED" },
    data: { status: "TRANSCRIBING" },
  });

  if (result.count === 0) {
    // Perdeu a corrida: outra chamada (retry concorrente, ou a operação já
    // não estava mais FAILED por outro motivo) já mudou o status.
    const current = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    return { outcome: "not_failed", video: current };
  }

  const updated = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });

  transcribeVideo(videoId).catch((error) => {
    console.error(`Falha ao repetir transcrição do vídeo ${videoId}:`, error);
  });

  return { outcome: "started", video: updated };
}

export async function retryClip(
  projectId: string,
  videoId: string,
  clipId: string,
  userId: string
): Promise<RetryClipResult> {
  const clip = await getOwnedClip(projectId, videoId, clipId, userId);

  if (!clip) {
    return { outcome: "not_found" };
  }

  if (clip.status !== "FAILED") {
    return { outcome: "not_failed", clip };
  }

  const result = await prisma.clip.updateMany({
    where: { id: clipId, status: "FAILED" },
    data: { status: "GENERATING" },
  });

  if (result.count === 0) {
    const current = await prisma.clip.findUniqueOrThrow({ where: { id: clipId } });
    return { outcome: "not_failed", clip: current };
  }

  const updated = await prisma.clip.findUniqueOrThrow({ where: { id: clipId } });

  generateClip(clipId).catch((error) => {
    console.error(`Falha ao repetir geração do clipe ${clipId}:`, error);
  });

  return { outcome: "started", clip: updated };
}
