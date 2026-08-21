import OpenAI from "openai";
import type { ClipAnalyzer, ClipSuggestion, TranscriptInput } from "./types";
import {
  computeTranscriptHash,
  getCachedAnalysis,
  saveAnalysisCache,
  type AnalysisCacheKey,
} from "./cache";

const DEFAULT_MODEL_ENV_HINT = "OPENAI_MODEL";

/**
 * Bump whenever buildSystemPrompt/buildUserPrompt change in a way that
 * could change the model's output for the same transcript — this is part
 * of the AnalysisCache lookup key (see cache.ts), so a stale prompt version
 * never serves suggestions produced by an older prompt.
 */
const ANALYZER_VERSION = "openai-suggestions-v1";

/**
 * Server-only provider: reads OPENAI_API_KEY via the OpenAI SDK's default
 * env lookup and is only ever invoked from lib/analysis/index.ts, which is
 * only imported by server-side routes. Never import this module from a
 * client component — doing so would attempt to bundle the API key.
 */
function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY não está definida. Configure a variável de ambiente para usar o provider 'openai'."
    );
  }

  return new OpenAI({ apiKey });
}

function getModel(): string {
  const model = process.env.OPENAI_MODEL;

  if (!model) {
    throw new Error(
      `${DEFAULT_MODEL_ENV_HINT} não está definida. Configure o modelo a ser usado pelo provider 'openai'.`
    );
  }

  return model;
}

function formatTranscriptForPrompt(transcript: TranscriptInput): string {
  return transcript.segments
    .map((segment) => `[${segment.start.toFixed(1)}s -> ${segment.end.toFixed(1)}s] ${segment.text.trim()}`)
    .join("\n");
}

function buildSystemPrompt(): string {
  return [
    "Você é um editor de vídeo especialista em identificar os melhores trechos de uma transcrição para virarem clipes curtos (Shorts/Reels/TikTok).",
    "Analise a transcrição completa, com marcações de tempo em segundos, e escolha os trechos com maior potencial de engajamento: momentos com ideias completas e autocontidas, ganchos fortes, humor, revelações, dados surpreendentes ou emoção.",
    "Regras obrigatórias:",
    "- Cada clipe deve durar entre 10 e 90 segundos.",
    "- startTime e endTime devem ser números em segundos, coerentes com os timestamps fornecidos na transcrição (não invente tempos fora do intervalo coberto pela transcrição).",
    "- endTime deve ser maior que startTime.",
    "- Não sugira mais de 8 clipes.",
    "- Não invente conteúdo que não está na transcrição.",
    "- Se a transcrição não tiver nenhum trecho aproveitável, retorne uma lista vazia.",
    "Responda APENAS com um objeto JSON válido, sem texto adicional, no seguinte formato:",
    '{"suggestions": [{"startTime": number, "endTime": number, "title": string, "reason": string, "score": number}]}',
    "- title: título curto e chamativo para o clipe (máx. 12 palavras).",
    "- reason: justificativa breve (1-2 frases) do porquê esse trecho funciona como clipe.",
    "- score: número de 0 a 100 indicando a força do candidato (100 = excelente).",
  ].join("\n");
}

function buildUserPrompt(transcript: TranscriptInput): string {
  const durationLine =
    transcript.duration != null
      ? `Duração total do vídeo: ${transcript.duration.toFixed(1)}s.`
      : "Duração total do vídeo desconhecida.";

  return [
    durationLine,
    "Transcrição com timestamps:",
    formatTranscriptForPrompt(transcript),
  ].join("\n\n");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Parses and validates the raw JSON text returned by the model into
 * ClipSuggestion[]. Kept separate from analyze() so it can be exercised
 * directly in tests with canned responses, without any network call.
 *
 * Deliberately conservative: any structural mismatch (not JSON, missing
 * `suggestions` array, malformed entries) throws instead of silently
 * dropping/fabricating data. sanitizeSuggestions (see sanitize.ts) still
 * runs afterwards on the caller side and re-validates every field, but this
 * parser must not let garbage through as if it were a valid ClipSuggestion.
 */
export function parseOpenAiResponse(rawContent: string | null | undefined): ClipSuggestion[] {
  if (!rawContent || !rawContent.trim()) {
    throw new Error("Resposta vazia da OpenAI: nenhum conteúdo retornado.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new Error("Resposta da OpenAI não é um JSON válido.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Resposta da OpenAI não é um objeto JSON.");
  }

  const suggestions = (parsed as Record<string, unknown>).suggestions;

  if (!Array.isArray(suggestions)) {
    throw new Error("Resposta da OpenAI não contém um array 'suggestions'.");
  }

  return suggestions.map((entry, i): ClipSuggestion => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Sugestão #${i} da OpenAI não é um objeto válido.`);
    }

    const { startTime, endTime, title, reason, score } = entry as Record<string, unknown>;

    if (!isFiniteNumber(startTime)) {
      throw new Error(`Sugestão #${i} da OpenAI tem startTime inválido.`);
    }
    if (!isFiniteNumber(endTime)) {
      throw new Error(`Sugestão #${i} da OpenAI tem endTime inválido.`);
    }
    if (typeof title !== "string" || !title.trim()) {
      throw new Error(`Sugestão #${i} da OpenAI tem title inválido.`);
    }
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error(`Sugestão #${i} da OpenAI tem reason inválido.`);
    }
    if (!isFiniteNumber(score)) {
      throw new Error(`Sugestão #${i} da OpenAI tem score inválido.`);
    }

    return { startTime, endTime, title, reason, score };
  });
}

export type OpenAiUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

/**
 * Maps the OpenAI SDK's `completion.usage` (absent on some responses, e.g.
 * certain error/streaming paths) into our own shape. Kept as a pure
 * function, mirroring parseOpenAiResponse, so it can be unit-tested without
 * a network call.
 */
export function mapUsage(usage: OpenAI.CompletionUsage | null | undefined): OpenAiUsage | null {
  if (!usage) return null;

  return {
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
  };
}

export type CacheLookupResult =
  | { hit: true; suggestions: ClipSuggestion[]; analysisCacheId: string }
  | { hit: false; cacheKey: AnalysisCacheKey };

/**
 * Network-free cache lookup — computes the cache key and checks Postgres,
 * nothing else. Safe to call before any quota check: on a hit, the caller
 * can return immediately without ever touching quota logic or the OpenAI
 * client. On a miss, returns the `cacheKey` so a subsequent call to
 * `runOpenAiAnalysis` doesn't need to recompute the transcript hash.
 */
export async function peekCachedSuggestions(
  transcript: TranscriptInput
): Promise<CacheLookupResult> {
  const model = getModel();
  const cacheKey: AnalysisCacheKey = {
    videoId: transcript.videoId,
    transcriptHash: computeTranscriptHash(transcript),
    model,
    analyzerVersion: ANALYZER_VERSION,
  };

  const cached = await getCachedAnalysis(cacheKey);

  if (cached) {
    console.log(
      `[openai-analyzer] cache hit — video=${transcript.videoId} model=${model} version=${ANALYZER_VERSION} analysisCacheId=${cached.id}`
    );

    return { hit: true, suggestions: cached.suggestions, analysisCacheId: cached.id };
  }

  return { hit: false, cacheKey };
}

/**
 * Does the actual OpenAI call and persists the result. Must only be called
 * after confirming a cache miss (via `peekCachedSuggestions`) — this
 * function has no concept of quota/users by design; a caller that needs to
 * enforce a usage limit must check it *between* the two calls, using the
 * gap this split creates. Never wrap this call in a Postgres transaction:
 * a network call to an external API (observed at 4-6s in this project) has
 * no place holding a DB row lock — see suggestions/route.ts for how the
 * quota check around this call is deliberately lock-free.
 */
export async function runOpenAiAnalysis(
  transcript: TranscriptInput,
  cacheKey: AnalysisCacheKey
): Promise<{ suggestions: ClipSuggestion[]; usage: OpenAiUsage | null; analysisCacheId: string }> {
  const client = getClient();

  let completion;
  try {
    completion = await client.chat.completions.create({
      model: cacheKey.model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(transcript) },
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Falha ao chamar a API da OpenAI: ${message}`);
  }

  const usage = mapUsage(completion.usage);
  console.log(
    `[openai-analyzer] cache miss — video=${transcript.videoId} model=${cacheKey.model} version=${cacheKey.analyzerVersion} usage: prompt_tokens=${usage?.promptTokens ?? "?"} completion_tokens=${usage?.completionTokens ?? "?"} total_tokens=${usage?.totalTokens ?? "?"}`
  );

  const rawContent = completion.choices[0]?.message?.content;
  const suggestions = parseOpenAiResponse(rawContent);

  // Persisted *before* returning: analysisCacheId (used by the caller to
  // build the AI_ANALYSIS idempotencyKey) only exists once this succeeds.
  // If this throws, the caller never reaches usage accounting — by
  // construction, not by a separate guard.
  const saved = await saveAnalysisCache(cacheKey, suggestions, usage);

  return { suggestions, usage, analysisCacheId: saved.id };
}

/**
 * Convenience orchestration of the two functions above, for callers that
 * just want a suggestion list plus metadata without needing to check quota
 * in between (e.g. `analyze()` below, or any standalone/test usage). Not
 * used by the quota-aware path in suggestions/route.ts, which calls
 * `peekCachedSuggestions`/`runOpenAiAnalysis` directly so it can check
 * quota strictly between a confirmed miss and the real network call.
 */
export async function analyzeWithUsage(
  transcript: TranscriptInput
): Promise<{
  suggestions: ClipSuggestion[];
  usage: OpenAiUsage | null;
  cacheHit: boolean;
  analysisCacheId: string;
}> {
  const lookup = await peekCachedSuggestions(transcript);

  if (lookup.hit) {
    return {
      suggestions: lookup.suggestions,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      cacheHit: true,
      analysisCacheId: lookup.analysisCacheId,
    };
  }

  const result = await runOpenAiAnalysis(transcript, lookup.cacheKey);

  return { ...result, cacheHit: false };
}

export const openAiAnalyzer: ClipAnalyzer = {
  name: "openai",

  async analyze(transcript: TranscriptInput): Promise<ClipSuggestion[]> {
    const { suggestions } = await analyzeWithUsage(transcript);
    return suggestions;
  },
};
