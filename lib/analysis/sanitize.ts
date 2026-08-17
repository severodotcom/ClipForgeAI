import type { ClipSuggestion, TranscriptInput, TranscriptSegment } from "./types";

const MIN_SCORE = 0;
const MAX_SCORE = 100;
const MAX_OVERLAP_RATIO = 0.5;
const MAX_RETURNED_SUGGESTIONS = 8;
const FALLBACK_TITLE = "Trecho sugerido";
const FALLBACK_REASON = "Sem justificativa fornecida pelo analisador.";

function isValidSegment(segment: unknown): segment is TranscriptSegment {
  if (!segment || typeof segment !== "object") return false;

  const { start, end, text } = segment as Record<string, unknown>;

  return (
    typeof text === "string" &&
    text.trim().length > 0 &&
    typeof start === "number" &&
    Number.isFinite(start) &&
    start >= 0 &&
    typeof end === "number" &&
    Number.isFinite(end) &&
    end > start
  );
}

/**
 * Defends every ClipAnalyzer implementation (mock today, a real LLM later)
 * against malformed transcript data: non-array segments, missing fields,
 * wrong types, NaN/negative timestamps, or zero-duration segments.
 */
export function sanitizeTranscript(transcript: TranscriptInput): TranscriptInput {
  const rawSegments = Array.isArray(transcript.segments) ? transcript.segments : [];

  return {
    ...transcript,
    segments: rawSegments.filter(isValidSegment),
  };
}

function overlapRatio(a: ClipSuggestion, b: ClipSuggestion) {
  const overlapStart = Math.max(a.startTime, b.startTime);
  const overlapEnd = Math.min(a.endTime, b.endTime);
  const overlap = Math.max(0, overlapEnd - overlapStart);
  const shorterDuration = Math.min(a.endTime - a.startTime, b.endTime - b.startTime);

  return shorterDuration > 0 ? overlap / shorterDuration : 0;
}

/**
 * Validates and repairs raw ClipAnalyzer output before it ever reaches the
 * client or gets persisted as a Clip: clamps score to 0-100, drops
 * suggestions with invalid/degenerate time ranges, clamps endTime to the
 * video's known duration, falls back title/reason to a safe default instead
 * of allowing empty strings, and suppresses suggestions that overlap too
 * much with a higher-scored one already accepted. This runs identically for
 * every provider — an analyzer only needs to propose candidates.
 */
export function sanitizeSuggestions(
  rawSuggestions: ClipSuggestion[],
  transcript: TranscriptInput
): ClipSuggestion[] {
  const duration =
    typeof transcript.duration === "number" && Number.isFinite(transcript.duration)
      ? transcript.duration
      : null;

  const cleaned = rawSuggestions
    .map((suggestion): ClipSuggestion | null => {
      if (
        typeof suggestion.startTime !== "number" ||
        !Number.isFinite(suggestion.startTime) ||
        suggestion.startTime < 0
      ) {
        return null;
      }

      if (
        typeof suggestion.endTime !== "number" ||
        !Number.isFinite(suggestion.endTime)
      ) {
        return null;
      }

      const endTime =
        duration != null && duration > 0
          ? Math.min(suggestion.endTime, duration)
          : suggestion.endTime;

      if (endTime <= suggestion.startTime) {
        return null;
      }

      const score = Math.min(
        MAX_SCORE,
        Math.max(
          MIN_SCORE,
          typeof suggestion.score === "number" && Number.isFinite(suggestion.score)
            ? suggestion.score
            : MIN_SCORE
        )
      );

      const title =
        typeof suggestion.title === "string" && suggestion.title.trim()
          ? suggestion.title.trim()
          : FALLBACK_TITLE;
      const reason =
        typeof suggestion.reason === "string" && suggestion.reason.trim()
          ? suggestion.reason.trim()
          : FALLBACK_REASON;

      return { startTime: suggestion.startTime, endTime, title, reason, score };
    })
    .filter((suggestion): suggestion is ClipSuggestion => suggestion !== null);

  const sortedByScore = [...cleaned].sort((a, b) => b.score - a.score);
  const accepted: ClipSuggestion[] = [];

  for (const candidate of sortedByScore) {
    const overlapsTooMuch = accepted.some(
      (existing) => overlapRatio(candidate, existing) > MAX_OVERLAP_RATIO
    );

    if (!overlapsTooMuch) {
      accepted.push(candidate);
    }
  }

  return accepted.slice(0, MAX_RETURNED_SUGGESTIONS);
}
