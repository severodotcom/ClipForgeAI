import type { TranscriptSegment } from "./types";

const DEFAULT_MAX_WORDS_PER_CHUNK = 1200;
const DEFAULT_MAX_CHUNK_DURATION_SECONDS = 20 * 60;

export type TranscriptChunk = {
  index: number;
  startTime: number;
  endTime: number;
  segments: TranscriptSegment[];
};

/**
 * Splits a transcript's segments into bounded chunks so a future LLM-backed
 * ClipAnalyzer can send one request per chunk instead of the whole
 * transcript at once — long videos (hours of audio) can otherwise exceed a
 * model's context window or blow up token cost per request. Purely local
 * and deterministic: no network calls, not wired into any analyzer yet.
 * A future analyzer would call this, run analyze() per chunk, and merge the
 * resulting ClipSuggestion[] (offsets are already absolute video time, so no
 * re-basing is needed).
 */
export function chunkTranscriptSegments(
  segments: TranscriptSegment[],
  options: { maxWords?: number; maxDurationSeconds?: number } = {}
): TranscriptChunk[] {
  const maxWords = options.maxWords ?? DEFAULT_MAX_WORDS_PER_CHUNK;
  const maxDuration = options.maxDurationSeconds ?? DEFAULT_MAX_CHUNK_DURATION_SECONDS;

  const chunks: TranscriptChunk[] = [];
  let bucket: TranscriptSegment[] = [];
  let wordCount = 0;

  function flush() {
    if (bucket.length === 0) return;

    chunks.push({
      index: chunks.length,
      startTime: bucket[0].start,
      endTime: bucket[bucket.length - 1].end,
      segments: bucket,
    });

    bucket = [];
    wordCount = 0;
  }

  for (const segment of segments) {
    const segmentWords = segment.text.trim().split(/\s+/).filter(Boolean).length;
    const prospectiveDuration = bucket.length > 0 ? segment.end - bucket[0].start : 0;

    if (
      bucket.length > 0 &&
      (wordCount + segmentWords > maxWords || prospectiveDuration > maxDuration)
    ) {
      flush();
    }

    bucket.push(segment);
    wordCount += segmentWords;
  }

  flush();

  return chunks;
}
