import { prisma } from "@/lib/prisma";
import { extractClip } from "@/lib/ffmpeg";
import { getVideoAbsolutePath, prepareClipOutputPath } from "@/lib/storage";

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

    await extractClip(inputPath, absolutePath, clip.startTime, clip.endTime);

    await prisma.clip.update({
      where: { id: clipId },
      data: { status: "COMPLETED", outputPath: relativePath },
    });
  } catch (error) {
    console.error(`Falha ao gerar o clipe ${clipId}:`, error);

    await prisma.clip.update({
      where: { id: clipId },
      data: { status: "FAILED" },
    });
  }
}
