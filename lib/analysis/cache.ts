import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { ClipSuggestion, TranscriptInput } from "./types";

export type CachedUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

/**
 * Deterministic content hash of a transcript, used as (part of) the
 * AnalysisCache lookup key. Must be computed from the same data that
 * actually reaches the prompt (duration + segment start/end/text) so that
 * any change to the transcript's content naturally produces a different
 * hash — this is the cache's invalidation mechanism, no explicit "clear
 * cache" step is needed when a video gets re-transcribed. Call this with
 * the already-sanitized transcript (post sanitizeTranscript) so discarded
 * invalid segments don't affect the hash. Rounding start/end to
 * milliseconds and trimming text guards against float/whitespace noise
 * producing spurious cache misses.
 */
export function computeTranscriptHash(transcript: TranscriptInput): string {
  const canonical = JSON.stringify({
    duration: transcript.duration,
    segments: transcript.segments.map((segment) => ({
      start: Number(segment.start.toFixed(3)),
      end: Number(segment.end.toFixed(3)),
      text: segment.text.trim(),
    })),
  });

  return createHash("sha256").update(canonical).digest("hex");
}

export type AnalysisCacheKey = {
  videoId: string;
  transcriptHash: string;
  model: string;
  analyzerVersion: string;
};

export async function getCachedAnalysis(
  key: AnalysisCacheKey
): Promise<ClipSuggestion[] | null> {
  const row = await prisma.analysisCache.findUnique({
    where: {
      videoId_transcriptHash_model_analyzerVersion: key,
    },
  });

  if (!row) return null;

  return row.suggestions as unknown as ClipSuggestion[];
}

/**
 * Persists a fresh analysis result and prunes now-stale cache rows for the
 * same (videoId, model, analyzerVersion) whose transcriptHash no longer
 * matches — i.e. cache entries left behind by a previous version of this
 * video's transcript. Rows for a different model/analyzerVersion are left
 * alone on purpose, so switching back to a previously-used model/prompt
 * version can still hit cache instead of always recomputing.
 *
 * Uses upsert (not create) so two concurrent cache-miss requests for the
 * same key don't race into a unique-constraint error.
 */
export async function saveAnalysisCache(
  key: AnalysisCacheKey,
  suggestions: ClipSuggestion[],
  usage: CachedUsage | null
): Promise<void> {
  const data = {
    suggestions: suggestions as unknown as object,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
  };

  await prisma.analysisCache.upsert({
    where: {
      videoId_transcriptHash_model_analyzerVersion: key,
    },
    create: { ...key, ...data },
    update: data,
  });

  await prisma.analysisCache.deleteMany({
    where: {
      videoId: key.videoId,
      model: key.model,
      analyzerVersion: key.analyzerVersion,
      transcriptHash: { not: key.transcriptHash },
    },
  });
}

/** Explicit invalidation for future use (e.g. a re-transcribe flow) — not
 * wired into any route yet, since no current flow re-transcribes a video
 * in place. */
export async function invalidateAnalysisCacheForVideo(videoId: string): Promise<void> {
  await prisma.analysisCache.deleteMany({ where: { videoId } });
}
