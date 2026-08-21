import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { peekCache, runAnalysis, type TranscriptInput } from "@/lib/analysis";
import { computeTranscriptHash, saveAnalysisCache } from "@/lib/analysis/cache";
import { checkQuota, getPeriodStart, getUsageThisPeriod, recordUsage } from "@/lib/usage";

const ANALYZER_VERSION = "openai-suggestions-v1"; // mirrors the private constant in openai-analyzer.ts

/**
 * Mocks the OpenAI SDK's chat.completions.create so this suite never makes
 * a real (paid) network call. `vi.mock` is hoisted above these imports by
 * vitest, so it's in effect before lib/analysis/openai-analyzer.ts (which
 * does `import OpenAI from "openai"`) is ever loaded.
 */
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

function completionOf(
  suggestions: Array<{ startTime: number; endTime: number; title: string; reason: string; score: number }>,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
) {
  return {
    choices: [{ message: { content: JSON.stringify({ suggestions }) } }],
    usage,
  };
}

const SAMPLE_SUGGESTIONS = [
  { startTime: 1, endTime: 8, title: "Título de teste", reason: "Motivo de teste", score: 80 },
];
const SAMPLE_USAGE = { prompt_tokens: 111, completion_tokens: 22, total_tokens: 133 };

function makeTranscript(videoId: string): TranscriptInput {
  return {
    videoId,
    duration: 50,
    text: "irrelevante para o hash",
    segments: [
      { start: 0, end: 5, text: "Olá pessoal, hoje vamos falar de um assunto importante" },
      { start: 5, end: 10, text: "e no final tem uma revelação surpreendente" },
    ],
  };
}

class QuotaExceededTestError extends Error {
  constructor(public readonly quota: Awaited<ReturnType<typeof checkQuota>>) {
    super("QUOTA_EXCEEDED");
  }
}

/**
 * Réplica, campo a campo, do corpo de
 * app/api/projects/[id]/videos/[videoId]/suggestions/route.ts (POST) a
 * partir do momento em que a transcrição já foi carregada: peekCache ->
 * (se miss) checkQuota -> runAnalysis -> (se miss real) recordUsage. Não
 * importamos o módulo da rota diretamente pelo mesmo motivo documentado em
 * usage.test.ts: ele usa `headers()` de `next/headers`, que só funciona
 * dentro do runtime real de uma request do Next.js.
 */
async function runSuggestionsFlow(userId: string, transcript: TranscriptInput) {
  const cachePeek = await peekCache(transcript);

  if (cachePeek.cacheHit) {
    return cachePeek.result;
  }

  if (cachePeek.requiresQuotaCheck) {
    const quota = await checkQuota(userId, UsageType.AI_ANALYSIS, 1);

    if (!quota.allowed) {
      throw new QuotaExceededTestError(quota);
    }
  }

  const result = await runAnalysis(transcript);

  if (!result.cacheHit && result.analysisCacheId) {
    await recordUsage({
      userId,
      type: UsageType.AI_ANALYSIS,
      amount: 1,
      periodStart: getPeriodStart(),
      idempotencyKey: `AI_ANALYSIS:${result.analysisCacheId}`,
      analysisCacheId: result.analysisCacheId,
      promptTokens: result.usage?.promptTokens ?? undefined,
      completionTokens: result.usage?.completionTokens ?? undefined,
      totalTokens: result.usage?.totalTokens ?? undefined,
    });
  }

  return result;
}

async function withEphemeralUser<T>(
  label: string,
  fn: (ctx: { userId: string; projectId: string; videoId: string }) => Promise<T>
): Promise<T> {
  const user = await prisma.user.create({
    data: { email: `ai-analysis-test-${label}-${randomUUID()}@clipforge.test`, name: label },
  });
  const project = await prisma.project.create({
    data: { userId: user.id, name: `Projeto ${label}` },
  });
  const video = await prisma.video.create({
    data: { projectId: project.id, originalFilename: `${label}.mp4`, status: "UPLOADED", duration: 50 },
  });

  try {
    return await fn({ userId: user.id, projectId: project.id, videoId: video.id });
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}

async function seedAiAnalysisUsage(userId: string, count: number) {
  const periodStart = getPeriodStart();
  await prisma.usageRecord.createMany({
    data: Array.from({ length: count }, () => ({
      userId,
      type: UsageType.AI_ANALYSIS,
      amount: 1,
      periodStart,
      idempotencyKey: `TEST_SEED:AI_ANALYSIS:${randomUUID()}`,
    })),
  });
}

describe("integração de AI_ANALYSIS (cache + quota + idempotência), provider openai", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("cache hit: zero UsageRecord, zero chamada à OpenAI", async () => {
    await withEphemeralUser("cache-hit", async ({ userId, videoId }) => {
      const transcript = makeTranscript(videoId);

      // Popula o cache diretamente (sem passar pela OpenAI) simulando uma
      // análise anterior já persistida.
      await saveAnalysisCache(
        {
          videoId,
          transcriptHash: computeTranscriptHash(transcript),
          model: process.env.OPENAI_MODEL!,
          analyzerVersion: ANALYZER_VERSION,
        },
        SAMPLE_SUGGESTIONS,
        { promptTokens: 999, completionTokens: 999, totalTokens: 1998 }
      );

      const result = await runSuggestionsFlow(userId, transcript);

      expect(result.cacheHit).toBe(true);
      expect(result.suggestions).toHaveLength(1);
      expect(mockCreate).not.toHaveBeenCalled();

      const usage = await getUsageThisPeriod(userId);
      expect(usage.aiAnalyses).toBe(0);

      const records = await prisma.usageRecord.findMany({
        where: { userId, type: UsageType.AI_ANALYSIS },
      });
      expect(records).toHaveLength(0);
    });
  });

  it("cache hit funciona mesmo com quota 10/10 já usada", async () => {
    await withEphemeralUser("cache-hit-quota-full", async ({ userId, videoId }) => {
      await seedAiAnalysisUsage(userId, 10);

      const transcript = makeTranscript(videoId);
      await saveAnalysisCache(
        {
          videoId,
          transcriptHash: computeTranscriptHash(transcript),
          model: process.env.OPENAI_MODEL!,
          analyzerVersion: ANALYZER_VERSION,
        },
        SAMPLE_SUGGESTIONS,
        { promptTokens: 50, completionTokens: 10, totalTokens: 60 }
      );

      const result = await runSuggestionsFlow(userId, transcript);

      expect(result.cacheHit).toBe(true);
      expect(result.suggestions).toHaveLength(1);
      expect(mockCreate).not.toHaveBeenCalled();

      // quota não muda: continua 10, não vira 11.
      const usage = await getUsageThisPeriod(userId);
      expect(usage.aiAnalyses).toBe(10);
    });
  });

  it("cache miss dentro da quota: chama OpenAI, salva cache, registra exatamente 1 UsageRecord com tokens e idempotencyKey corretos", async () => {
    await withEphemeralUser("cache-miss-ok", async ({ userId, videoId }) => {
      mockCreate.mockResolvedValueOnce(completionOf(SAMPLE_SUGGESTIONS, SAMPLE_USAGE));

      const transcript = makeTranscript(videoId);
      const result = await runSuggestionsFlow(userId, transcript);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(result.cacheHit).toBe(false);
      expect(result.analysisCacheId).toBeTruthy();
      expect(result.suggestions).toHaveLength(1);

      const usage = await getUsageThisPeriod(userId);
      expect(usage.aiAnalyses).toBe(1);

      const records = await prisma.usageRecord.findMany({
        where: { userId, type: UsageType.AI_ANALYSIS },
      });
      expect(records).toHaveLength(1);
      expect(records[0].analysisCacheId).toBe(result.analysisCacheId);
      expect(records[0].idempotencyKey).toBe(`AI_ANALYSIS:${result.analysisCacheId}`);
      expect(records[0].promptTokens).toBe(111);
      expect(records[0].completionTokens).toBe(22);
      expect(records[0].totalTokens).toBe(133);

      const cacheRow = await prisma.analysisCache.findUnique({ where: { id: result.analysisCacheId! } });
      expect(cacheRow).not.toBeNull();
      expect(cacheRow?.videoId).toBe(videoId);
    });
  });

  it("cache miss com quota 10/10: retorna QUOTA_EXCEEDED e a OpenAI não é chamada", async () => {
    await withEphemeralUser("cache-miss-quota-full", async ({ userId, videoId }) => {
      await seedAiAnalysisUsage(userId, 10);

      const transcript = makeTranscript(videoId);

      await expect(runSuggestionsFlow(userId, transcript)).rejects.toThrow("QUOTA_EXCEEDED");

      expect(mockCreate).not.toHaveBeenCalled();

      const cacheRow = await prisma.analysisCache.findUnique({
        where: {
          videoId_transcriptHash_model_analyzerVersion: {
            videoId,
            transcriptHash: computeTranscriptHash(transcript),
            model: process.env.OPENAI_MODEL!,
            analyzerVersion: ANALYZER_VERSION,
          },
        },
      });
      expect(cacheRow).toBeNull();

      const records = await prisma.usageRecord.findMany({
        where: { userId, type: UsageType.AI_ANALYSIS },
      });
      expect(records).toHaveLength(10); // continua 10, nenhum novo
    });
  });

  it("erro da OpenAI: nenhum UsageRecord é criado", async () => {
    await withEphemeralUser("openai-error", async ({ userId, videoId }) => {
      mockCreate.mockRejectedValueOnce(new Error("network boom"));

      const transcript = makeTranscript(videoId);

      await expect(runSuggestionsFlow(userId, transcript)).rejects.toThrow(
        "Falha ao chamar a API da OpenAI"
      );

      const records = await prisma.usageRecord.findMany({
        where: { userId, type: UsageType.AI_ANALYSIS },
      });
      expect(records).toHaveLength(0);
    });
  });

  it("falha ao salvar o cache: nenhum UsageRecord é criado", async () => {
    // videoId que não existe de verdade -> saveAnalysisCache viola a FK de
    // AnalysisCache.videoId -> Video.id. A OpenAI (mockada) já respondeu
    // com sucesso; o que falha é exclusivamente a persistência do cache.
    const user = await prisma.user.create({
      data: { email: `ai-analysis-test-cache-fail-${randomUUID()}@clipforge.test`, name: "cache-fail" },
    });

    try {
      mockCreate.mockResolvedValueOnce(completionOf(SAMPLE_SUGGESTIONS, SAMPLE_USAGE));

      const transcript = makeTranscript("video-que-nao-existe-" + randomUUID());

      await expect(runSuggestionsFlow(user.id, transcript)).rejects.toThrow();

      expect(mockCreate).toHaveBeenCalledTimes(1); // a chamada à OpenAI aconteceu

      const records = await prisma.usageRecord.findMany({
        where: { userId: user.id, type: UsageType.AI_ANALYSIS },
      });
      expect(records).toHaveLength(0);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("repetir recordUsage para o mesmo analysisCacheId não duplica o UsageRecord", async () => {
    await withEphemeralUser("retry-recordusage", async ({ userId, videoId }) => {
      mockCreate.mockResolvedValueOnce(completionOf(SAMPLE_SUGGESTIONS, SAMPLE_USAGE));

      const transcript = makeTranscript(videoId);
      const result = await runSuggestionsFlow(userId, transcript);
      const idempotencyKey = `AI_ANALYSIS:${result.analysisCacheId}`;

      // Simula um retry da mesma requisição chamando recordUsage de novo.
      await recordUsage({
        userId,
        type: UsageType.AI_ANALYSIS,
        amount: 1,
        periodStart: getPeriodStart(),
        idempotencyKey,
        analysisCacheId: result.analysisCacheId!,
        promptTokens: 111,
        completionTokens: 22,
        totalTokens: 133,
      });

      const records = await prisma.usageRecord.findMany({ where: { idempotencyKey } });
      expect(records).toHaveLength(1);
    });
  });

  it("provider mock continua funcionando (sem quota, sem chamada à OpenAI)", async () => {
    vi.stubEnv("CLIP_ANALYZER_PROVIDER", "mock");

    await withEphemeralUser("mock-provider", async ({ userId, videoId }) => {
      const transcript = makeTranscript(videoId);

      const peek = await peekCache(transcript);
      expect(peek.cacheHit).toBe(false);
      if (!peek.cacheHit) {
        expect(peek.requiresQuotaCheck).toBe(false);
      }

      const result = await runSuggestionsFlow(userId, transcript);

      expect(result.cacheHit).toBe(false);
      expect(result.analysisCacheId).toBeNull();
      expect(result.usage).toBeNull();
      expect(mockCreate).not.toHaveBeenCalled();

      const records = await prisma.usageRecord.findMany({
        where: { userId, type: UsageType.AI_ANALYSIS },
      });
      expect(records).toHaveLength(0);
    });
  });

  it(
    "duas requisições concorrentes em cache miss não criam dois UsageRecords " +
      "(mas isso NÃO garante que a OpenAI só seja chamada uma vez — ver asserção de mockCreate abaixo)",
    async () => {
      await withEphemeralUser("concurrent-miss", async ({ userId, videoId }) => {
        mockCreate.mockResolvedValue(completionOf(SAMPLE_SUGGESTIONS, SAMPLE_USAGE));

        const transcript = makeTranscript(videoId);

        const [resultA, resultB] = await Promise.all([
          runSuggestionsFlow(userId, transcript),
          runSuggestionsFlow(userId, transcript),
        ]);

        // Documentado explicitamente (não é um bug): duas requisições
        // simultâneas em cache miss genuinamente disparam duas chamadas à
        // OpenAI — o custo real, se isso acontecesse em produção, seria
        // pago duas vezes. A idempotência (idempotencyKey amarrada ao
        // mesmo AnalysisCache.id, já que ambas resolvem para a mesma linha
        // via upsert) só protege a CONTAGEM no ledger, não o custo.
        expect(mockCreate.mock.calls.length).toBeGreaterThanOrEqual(1);

        expect(resultA.analysisCacheId).toBe(resultB.analysisCacheId);

        const records = await prisma.usageRecord.findMany({
          where: { userId, type: UsageType.AI_ANALYSIS },
        });
        expect(records).toHaveLength(1);
      });
    }
  );
});
