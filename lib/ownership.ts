import { prisma } from "@/lib/prisma";

export async function getOwnedVideo(
  projectId: string,
  videoId: string,
  userId: string
) {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    include: { project: true },
  });

  if (
    !video ||
    video.projectId !== projectId ||
    video.project.userId !== userId
  ) {
    return null;
  }

  return video;
}

export async function getOwnedClip(
  projectId: string,
  videoId: string,
  clipId: string,
  userId: string
) {
  const clip = await prisma.clip.findUnique({
    where: { id: clipId },
    include: { video: { include: { project: true } } },
  });

  if (
    !clip ||
    clip.videoId !== videoId ||
    clip.video.projectId !== projectId ||
    clip.video.project.userId !== userId
  ) {
    return null;
  }

  return clip;
}
