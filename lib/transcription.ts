import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WaveFile } from "wavefile";
import { prisma } from "@/lib/prisma";
import { getWhisperPipeline } from "@/lib/whisper";
import { extractAudioWav } from "@/lib/ffmpeg";
import { getVideoAbsolutePath } from "@/lib/storage";

type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

type TranscriptChunk = {
  timestamp: [number, number];
  text: string;
};

// Bounds how long we wait for the Whisper inference call before giving up.
// Overridable via env; default is generous since a long video can
// legitimately take a while to transcribe on CPU.
//
// Unlike ffmpeg (lib/ffmpeg.ts), Whisper here runs in-process via
// @huggingface/transformers — there is no child process to SIGTERM/SIGKILL.
// This timeout only stops *waiting* on the Promise: if it fires, the
// underlying inference may keep consuming CPU in the background until it
// finishes on its own (or the process exits), even though transcribeVideo
// has already moved on and marked the video FAILED. A stuck/runaway
// transcription can still degrade other work sharing the same process in
// the meantime — bounding how many of these can run at once (planned,
// separately, as a concurrency semaphore) is what actually closes that gap.
const WHISPER_TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS) || 30 * 60 * 1000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Assumes video.duration is already known and persisted — the caller
 * (POST /api/projects/[id]/videos) determines duration via ffprobe and
 * checks the TRANSCRIPTION_MINUTES quota *before* ever invoking this
 * function, so transcription never starts (and no minutes are ever spent
 * inside here) for a video that doesn't fit the user's remaining quota.
 * This function no longer probes duration itself or records usage — both
 * already happened at the call site, inside the same locked transaction
 * that decided it was safe to proceed.
 */
export async function transcribeVideo(videoId: string) {
  const video = await prisma.video.findUnique({ where: { id: videoId } });

  if (!video || !video.storagePath || video.duration == null) {
    return;
  }

  const duration = video.duration;

  await prisma.video.update({
    where: { id: videoId },
    data: { status: "TRANSCRIBING" },
  });

  const inputPath = getVideoAbsolutePath(video.storagePath);
  const workDir = await mkdtemp(path.join(tmpdir(), "clipforge-audio-"));
  const wavPath = path.join(workDir, "audio.wav");

  try {
    await extractAudioWav(inputPath, wavPath);

    const wav = new WaveFile(readFileSync(wavPath));
    wav.toBitDepth("32f");
    wav.toSampleRate(16000);

    let audioData = wav.getSamples();
    if (Array.isArray(audioData)) {
      audioData = audioData[0];
    }

    const transcriber = await getWhisperPipeline();
    const output = await withTimeout(
      transcriber(audioData, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
      }),
      WHISPER_TIMEOUT_MS,
      `Transcrição excedeu o tempo limite de ${WHISPER_TIMEOUT_MS}ms`
    );

    const result = Array.isArray(output) ? output[0] : output;

    const segments: TranscriptSegment[] = (result.chunks ?? []).map(
      (chunk: TranscriptChunk) => ({
        start: chunk.timestamp[0] ?? 0,
        end: chunk.timestamp[1] ?? duration,
        text: chunk.text,
      })
    );

    await prisma.transcription.upsert({
      where: { videoId },
      create: {
        videoId,
        text: result.text,
        segments,
      },
      update: {
        text: result.text,
        segments,
      },
    });

    await prisma.video.update({
      where: { id: videoId },
      data: { status: "UPLOADED" },
    });
  } catch (error) {
    console.error(`Falha ao transcrever vídeo ${videoId}:`, error);

    await prisma.video.update({
      where: { id: videoId },
      data: { status: "FAILED" },
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
