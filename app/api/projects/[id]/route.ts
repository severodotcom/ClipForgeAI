import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deleteProjectFiles } from "@/lib/storage";
import { checkRateLimit, rateLimitKey, rateLimitResponse, RATE_LIMIT_RULES } from "@/lib/rate-limit";
import type { VideoStatus } from "@prisma/client";
import { headers } from "next/headers";

// Mesmo conjunto de status "em andamento" usado pelo DELETE de vídeo
// (app/api/projects/[id]/videos/[videoId]/route.ts) e pela reconciliação
// (lib/reconciliation.ts): excluir o projeto cascatearia a exclusão desses
// vídeos enquanto um job de Whisper/ffmpeg ainda pode estar ativo contra o
// arquivo físico deles — bloqueado pelo mesmo motivo que já bloqueia a
// exclusão individual do vídeo.
const BLOCKED_VIDEO_STATUSES: VideoStatus[] = ["TRANSCRIBING", "ANALYZING", "GENERATING"];

export async function GET(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]">
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

  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      videos: {
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!project || project.userId !== session.user.id) {
    return Response.json(
      { error: "Projeto não encontrado" },
      { status: 404 }
    );
  }

  return Response.json(project);
}

export async function DELETE(
  request: Request,
  { params }: RouteContext<"/api/projects/[id]">
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

  // P2g: rate limit checado logo após autenticar, antes de ownership/
  // storage/banco — mesmo padrão já usado em upload/retry/clip-generation
  // (ver P2a).
  const rateDecision = checkRateLimit(
    rateLimitKey("project-delete", session.user.id),
    RATE_LIMIT_RULES.PROJECT_DELETE
  );

  if (!rateDecision.allowed) {
    return rateLimitResponse(rateDecision);
  }

  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
  });

  if (!project || project.userId !== session.user.id) {
    return Response.json(
      { error: "Projeto não encontrado" },
      { status: 404 }
    );
  }

  // Bloqueia a exclusão do projeto se qualquer um dos seus vídeos estiver
  // em processamento — verificado ANTES de ler storagePath/outputPath,
  // remover qualquer arquivo ou tocar o banco, para que nenhum efeito
  // colateral (storage, UsageRecord, quota) ocorra neste caso.
  const processingVideo = await prisma.video.findFirst({
    where: { projectId: id, status: { in: BLOCKED_VIDEO_STATUSES } },
    select: { id: true },
  });

  if (processingVideo) {
    return Response.json(
      {
        error: "O projeto tem vídeos em processamento e não pode ser excluído agora.",
        code: "PROJECT_HAS_PROCESSING_VIDEOS",
      },
      { status: 409 }
    );
  }

  const videos = await prisma.video.findMany({
    where: { projectId: id },
    select: {
      storagePath: true,
      clips: { select: { outputPath: true } },
    },
  });

  const videoPaths = videos
    .map((video) => video.storagePath)
    .filter((storagePath): storagePath is string => storagePath != null);

  const clipPaths = videos
    .flatMap((video) => video.clips.map((clip) => clip.outputPath))
    .filter((outputPath): outputPath is string => outputPath != null);

  try {
    await deleteProjectFiles({ videoPaths, clipPaths });
  } catch (error) {
    // Erro real de filesystem (não ENOENT) — aborta antes de tocar o
    // banco, para nunca ficar com o projeto apagado e arquivos físicos
    // ainda em disco sem nenhuma linha que os referencie.
    console.error(`Falha ao remover arquivos físicos do projeto ${id}:`, error);

    return Response.json(
      { error: "Falha ao remover os arquivos do projeto" },
      { status: 500 }
    );
  }

  // Ownership reforçado também na própria exclusão (não só na busca acima)
  // e count-based em vez de prisma.project.delete, para que uma segunda
  // chamada concorrente (duplo clique, retry de rede) encontre a linha já
  // ausente e responda 404 em vez de lançar P2025.
  const result = await prisma.project.deleteMany({
    where: { id, userId: session.user.id },
  });

  if (result.count === 0) {
    return Response.json(
      { error: "Projeto não encontrado" },
      { status: 404 }
    );
  }

  // Cascade do PostgreSQL (onDelete: Cascade no schema) remove Video,
  // Transcription, Clip e AnalysisCache associados — não reimplementado
  // aqui.
  return new Response(null, { status: 204 });
}
