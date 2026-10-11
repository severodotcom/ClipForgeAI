import { prisma } from "@/lib/prisma";
import { clipSemaphore } from "@/lib/concurrency";
import { extractClip } from "@/lib/ffmpeg";
import { getVideoAbsolutePath, prepareClipOutputPath } from "@/lib/storage";
import { sanitizeFailureReason } from "@/lib/errors";

export async function generateClip(clipId: string) {
  const clip = await prisma.clip.findUnique({
    where: { id: clipId },
    include: { video: true },
  });

  if (!clip || !clip.video.storagePath) {
    return;
  }

  await prisma.clip.update({
    where: { id: clipId },
    data: { status: "GENERATING" },
  });

  try {
    const inputPath = getVideoAbsolutePath(clip.video.storagePath);
    const { relativePath, absolutePath } = await prepareClipOutputPath({
      projectId: clip.video.projectId,
      videoId: clip.videoId,
      clipId: clip.id,
    });

    // clipSemaphore.run só chama extractClip (o ffmpeg pesado) depois de
    // garantir que nenhuma outra geração de clipe está rodando neste
    // processo — ver lib/concurrency.ts.
    await clipSemaphore.run(() =>
      extractClip(inputPath, absolutePath, clip.startTime, clip.endTime)
    );

    await prisma.clip.update({
      where: { id: clipId },
      data: { status: "COMPLETED", outputPath: relativePath, errorMessage: null },
    });
  } catch (error) {
    console.error(`Falha ao gerar o clipe ${clipId}:`, error);

    await prisma.clip.update({
      where: { id: clipId },
      data: { status: "FAILED", errorMessage: sanitizeFailureReason(error) },
    });
  }
}
