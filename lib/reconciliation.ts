import type { ClipStatus, VideoStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Reconciliação executada uma vez na inicialização do processo (ver
// instrumentation.ts): detecta Video/Clip presos em um status "em
// andamento" porque o processo anterior morreu (crash, deploy, restart) no
// meio do processamento — antes de qualquer timeout interno
// (WHISPER_TIMEOUT_MS em lib/transcription.ts, FFMPEG_TIMEOUT_MS em
// lib/ffmpeg.ts) ter tido a chance de marcar a linha como FAILED sozinho.
//
// Critério de stale: usa Video.updatedAt/Clip.updatedAt (coluna @updatedAt,
// atualizada automaticamente pelo Prisma em todo update/updateMany) como
// "quando essa linha foi tocada pela última vez" — não createdAt. Isso
// importa especificamente para retry manual (ver lib/retry.ts): um retry
// transiciona a linha de volta para um status "em andamento" via
// updateMany, o que já bate o updatedAt para agora. Se a checagem de
// staleness ainda usasse createdAt, um vídeo/clipe antigo que acabou de ser
// retried (mas cujo createdAt original já passou de RECONCILE_STALE_AFTER_MS)
// seria marcado FAILED de novo no próximo boot, mesmo tendo acabado de
// começar a reprocessar — bug real encontrado ao desenhar o retry, não
// apenas hipotético. RECONCILE_STALE_AFTER_MS fica bem acima da soma dos
// timeouts internos mais uma margem para espera na fila dos semáforos de
// concorrência (lib/concurrency.ts, no máximo 1 transcrição e 1 geração de
// clipe simultânea) — suficiente para não marcar como FAILED uma operação
// que só está esperando sua vez na fila ou ainda dentro do seu timeout
// normal.
//
// Válido só para uma instância de processo — não coordena nada entre
// processos/instâncias (não há lock distribuído). Não tenta re-executar a
// operação, apenas marca FAILED; retry é tratado separadamente (P1e).
const DEFAULT_STALE_AFTER_MS = 2 * 60 * 60 * 1000; // 2h
export const RECONCILE_STALE_AFTER_MS =
  Number(process.env.RECONCILE_STALE_AFTER_MS) || DEFAULT_STALE_AFTER_MS;

const STUCK_VIDEO_STATUSES: VideoStatus[] = ["TRANSCRIBING", "ANALYZING", "GENERATING"];
const STUCK_CLIP_STATUSES: ClipStatus[] = ["GENERATING"];

export type ReconciliationResult = {
  videosMarkedFailed: number;
  clipsMarkedFailed: number;
};

// `now` é injetável apenas para testes determinísticos (evita depender do
// relógio real / sleeps); em produção sempre usa o momento real (default).
export async function reconcileStuckOperations(now: Date = new Date()): Promise<ReconciliationResult> {
  const staleBefore = new Date(now.getTime() - RECONCILE_STALE_AFTER_MS);

  // Cada updateMany já é idempotente por construção: o `where` só casa com
  // linhas que ainda estão em um status "em andamento" E mais velhas que o
  // limite — uma linha já marcada FAILED (por esta chamada ou por uma
  // anterior) nunca é candidata de novo, então rodar isto de novo (ou
  // várias vezes seguidas) é seguro e não tem efeito adicional.
  const [videos, clips] = await Promise.all([
    prisma.video.updateMany({
      where: {
        status: { in: STUCK_VIDEO_STATUSES },
        updatedAt: { lt: staleBefore },
      },
      data: { status: "FAILED" },
    }),
    prisma.clip.updateMany({
      where: {
        status: { in: STUCK_CLIP_STATUSES },
        updatedAt: { lt: staleBefore },
      },
      data: { status: "FAILED" },
    }),
  ]);

  if (videos.count > 0 || clips.count > 0) {
    console.warn(
      `[reconciliation] Marcados como FAILED: ${videos.count} vídeo(s) e ${clips.count} clipe(s) presos de uma execução anterior.`
    );
  }

  return { videosMarkedFailed: videos.count, clipsMarkedFailed: clips.count };
}
