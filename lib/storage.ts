import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

const VIDEO_STORAGE_ROOT = path.join(process.cwd(), "storage", "videos");
const CLIP_STORAGE_ROOT = path.join(process.cwd(), "storage", "clips");

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

export async function saveVideoFile({
  projectId,
  videoId,
  file,
}: {
  projectId: string;
  videoId: string;
  file: File;
}) {
  const projectDir = path.join(VIDEO_STORAGE_ROOT, projectId);
  await mkdir(projectDir, { recursive: true });

  const safeName = `${videoId}-${sanitizeFilename(file.name)}`;
  const absolutePath = path.join(projectDir, safeName);

  await pipeline(
    Readable.fromWeb(file.stream() as never),
    createWriteStream(absolutePath)
  );

  return path.join(projectId, safeName);
}

export function getVideoAbsolutePath(storagePath: string) {
  return path.join(VIDEO_STORAGE_ROOT, storagePath);
}

export async function prepareClipOutputPath({
  projectId,
  videoId,
  clipId,
}: {
  projectId: string;
  videoId: string;
  clipId: string;
}) {
  const dir = path.join(CLIP_STORAGE_ROOT, projectId, videoId);
  await mkdir(dir, { recursive: true });

  const relativePath = path.join(projectId, videoId, `${clipId}.mp4`);

  return {
    relativePath,
    absolutePath: path.join(CLIP_STORAGE_ROOT, relativePath),
  };
}

export function getClipAbsolutePath(storagePath: string) {
  return path.join(CLIP_STORAGE_ROOT, storagePath);
}

/**
 * Removes one file, treating "already gone" (ENOENT) as success — the
 * caller doesn't care whether this call or a previous one (or a manual
 * cleanup) actually removed it, only that it's gone now. Any other error
 * (permission, I/O, etc.) is a real failure and is rethrown: callers doing
 * physical-delete-before-db-delete rely on this to abort before touching
 * the database (see deleteVideoFile/deleteClipFile/deleteProjectFiles).
 */
async function removeFileTolerant(absolutePath: string): Promise<void> {
  try {
    await rm(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }
}

/**
 * Deletes the original video file for a previously-saved video.
 * `storagePath` must be the relative path already stored on `Video.storagePath`
 * (never a client-supplied absolute path) — resolved the same way reads do,
 * via getVideoAbsolutePath.
 */
export async function deleteVideoFile(storagePath: string): Promise<void> {
  await removeFileTolerant(getVideoAbsolutePath(storagePath));
}

/**
 * Deletes one generated clip file. `storagePath` must be the relative path
 * already stored on `Clip.outputPath` — same constraint as deleteVideoFile.
 */
export async function deleteClipFile(storagePath: string): Promise<void> {
  await removeFileTolerant(getClipAbsolutePath(storagePath));
}

/**
 * Deletes every physical file (video originals + generated clips) for a
 * project being deleted. Callers pass the relative storagePath/outputPath
 * values already read from the database (never raw client input) and are
 * expected to have filtered out null entries (videos/clips that never
 * finished processing have no file to delete).
 *
 * Stops at the first non-ENOENT error (propagated to the caller) instead of
 * attempting the remaining files — the caller must not proceed to delete
 * the database rows once any real filesystem error happens here.
 */
export async function deleteProjectFiles(paths: {
  videoPaths: string[];
  clipPaths: string[];
}): Promise<void> {
  for (const videoPath of paths.videoPaths) {
    await deleteVideoFile(videoPath);
  }

  for (const clipPath of paths.clipPaths) {
    await deleteClipFile(clipPath);
  }
}
