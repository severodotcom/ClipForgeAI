export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptInput = {
  videoId: string;
  duration: number | null;
  text: string;
  segments: TranscriptSegment[];
};

export type ClipSuggestion = {
  startTime: number;
  endTime: number;
  title: string;
  reason: string;
  /** 0-100, higher means a stronger candidate. Callers must not assume an
   * analyzer already clamped this — see sanitizeSuggestions. */
  score: number;
};

/**
 * Contract every clip-suggestion provider implements — the mock heuristic
 * today, a real LLM-backed analyzer later. Callers (routes, UI) only ever
 * depend on this interface, never on a concrete provider.
 *
 * Implementations do not need to validate their own output: `analyze()`'s
 * return value is treated as untrusted and is re-validated/repaired by
 * `sanitizeSuggestions` (see sanitize.ts) before it reaches a client or gets
 * persisted — invalid or out-of-range candidates are dropped or clamped,
 * never trusted as-is. This is what lets a network-calling implementation
 * (parsing a real LLM's JSON response, which can be malformed, incomplete,
 * or hallucinated) stay just as safe as the deterministic mock.
 *
 * `analyze()` should reject/throw on unrecoverable failure (network error,
 * unparseable response, timeout) rather than returning fabricated data —
 * the caller treats a thrown error as "no suggestions available right now"
 * and reports it to the user, instead of silently persisting bad data.
 */
export interface ClipAnalyzer {
  readonly name: string;
  analyze(transcript: TranscriptInput): Promise<ClipSuggestion[]>;
}
