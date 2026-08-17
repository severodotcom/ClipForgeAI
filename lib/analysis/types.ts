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

export interface ClipAnalyzer {
  readonly name: string;
  analyze(transcript: TranscriptInput): Promise<ClipSuggestion[]>;
}
