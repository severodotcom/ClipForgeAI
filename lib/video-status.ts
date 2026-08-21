import type { ClipStatus, VideoStatus } from "@prisma/client";

export const VIDEO_STATUS_LABELS: Record<VideoStatus, string> = {
  UPLOADING: "Enviando",
  UPLOADED: "Enviado",
  TRANSCRIBING: "Transcrevendo...",
  ANALYZING: "Analisando...",
  GENERATING: "Gerando clipes...",
  COMPLETED: "Concluído",
  FAILED: "Falhou",
  QUOTA_EXCEEDED: "Limite de minutos do plano atingido neste período",
};

export const CLIP_STATUS_LABELS: Record<ClipStatus, string> = {
  PENDING: "Na fila",
  GENERATING: "Gerando...",
  COMPLETED: "Pronto",
  FAILED: "Falhou",
};
