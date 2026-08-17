import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WaveFile } from "wavefile";
import { prisma } from "@/lib/prisma";
import { getWhisperPipeline } from "@/lib/whisper";
import { getAudioDuration, extractAudioWav } from "@/lib/ffmpeg";
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

export async function transcribeVideo(videoId: string) {
  const video = await prisma.video.findUnique({ where: { id: videoId } });

  if (!video || !video.storagePath) {
    return;
  }

  await prisma.video.update({
    where: { id: videoId },
    data: { status: "TRANSCRIBING" },
  });

  const inputPath = getVideoAbsolutePath(video.storagePath);
  const workDir = await mkdtemp(path.join(tmpdir(), "clipforge-audio-"));
  const wavPath = path.join(workDir, "audio.wav");

  try {
    const duration = await getAudioDuration(inputPath);
    await extractAudioWav(inputPath, wavPath);

    const wav = new WaveFile(readFileSync(wavPath));
    wav.toBitDepth("32f");
    wav.toSampleRate(16000);

    let audioData = wav.getSamples();
    if (Array.isArray(audioData)) {
      audioData = audioData[0];
    }

    const transcriber = await getWhisperPipeline();
    const output = await transcriber(audioData, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
    });

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
      data: { duration, status: "UPLOADED" },
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
