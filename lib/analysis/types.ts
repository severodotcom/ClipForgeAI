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
  score: number;
};

export interface ClipAnalyzer {
  readonly name: string;
  analyze(transcript: TranscriptInput): Promise<ClipSuggestion[]>;
}
