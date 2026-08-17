import type { ClipSuggestion, TranscriptInput, TranscriptSegment } from "./types";

const MIN_SCORE = 0;
const MAX_SCORE = 100;
const MAX_OVERLAP_RATIO = 0.5;
const MAX_RETURNED_SUGGESTIONS = 8;
const FALLBACK_TITLE = "Trecho sugerido";
const FALLBACK_REASON = "Sem justificativa fornecida pelo analisador.";
const MIN_SUGGESTION_DURATION_SECONDS = 1;
const MAX_SUGGESTION_DURATION_SECONDS = 10 * 60;
const MAX_TITLE_LENGTH = 200;
const MAX_REASON_LENGTH = 500;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

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
 * client or gets persisted as a Clip. The input is treated as fully
 * untrusted (typed `unknown`, not `ClipSuggestion[]`) because a real
 * provider's output crosses a runtime boundary (parsed JSON from an LLM
 * response) where TypeScript's compile-time types offer no guarantee: it
 * might not even be an array, and its elements might not be objects at all.
 *
 * Repairs/enforces: input must be an array of objects; startTime/endTime
 * must be finite numbers with endTime > startTime; endTime is clamped to
 * the video's known duration; suggestion duration is clamped to at most 10
 * minutes and dropped if under 1 second; score is clamped to 0-100; title
 * and reason fall back to a safe default instead of being empty, and are
 * length-capped; and suggestions overlapping >50% with a higher-scored one
 * already accepted are suppressed. This runs identically for every
 * provider — an analyzer only needs to propose candidates.
 */
export function sanitizeSuggestions(
  rawSuggestions: unknown,
  transcript: TranscriptInput
): ClipSuggestion[] {
  const duration =
    typeof transcript.duration === "number" && Number.isFinite(transcript.duration)
      ? transcript.duration
      : null;

  if (!Array.isArray(rawSuggestions)) {
    console.warn(
      `sanitizeSuggestions: analyzer output was not an array (got ${typeof rawSuggestions}), discarding.`
    );
    return [];
  }

  const cleaned = rawSuggestions
    .map((raw): ClipSuggestion | null => {
      if (!isPlainObject(raw)) {
        console.warn("sanitizeSuggestions: dropped a non-object suggestion entry.");
        return null;
      }

      const suggestion = raw as Partial<ClipSuggestion>;

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

      let endTime =
        duration != null && duration > 0
          ? Math.min(suggestion.endTime, duration)
          : suggestion.endTime;

      if (endTime <= suggestion.startTime) {
        return null;
      }

      if (endTime - suggestion.startTime < MIN_SUGGESTION_DURATION_SECONDS) {
        return null;
      }

      endTime = Math.min(endTime, suggestion.startTime + MAX_SUGGESTION_DURATION_SECONDS);

      const score = Math.min(
        MAX_SCORE,
        Math.max(
          MIN_SCORE,
          typeof suggestion.score === "number" && Number.isFinite(suggestion.score)
            ? suggestion.score
            : MIN_SCORE
        )
      );

      const title = truncate(
        typeof suggestion.title === "string" && suggestion.title.trim()
          ? suggestion.title.trim()
          : FALLBACK_TITLE,
        MAX_TITLE_LENGTH
      );
      const reason = truncate(
        typeof suggestion.reason === "string" && suggestion.reason.trim()
          ? suggestion.reason.trim()
          : FALLBACK_REASON,
        MAX_REASON_LENGTH
      );

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
