import { prisma } from "@/lib/prisma";
import { UsageType, type Plan, type Prisma } from "@prisma/client";

/**
 * Every function below accepts an optional trailing Prisma client, defaulting
 * to the shared `prisma` singleton. Pass a transaction's client (`tx` from
 * `prisma.$transaction(async (tx) => ...)`) when the call needs to
 * participate in the same transaction/lock as other writes — see
 * `lockUserForQuota` for why this matters for concurrency safety.
 */
type PrismaClientOrTx = typeof prisma | Prisma.TransactionClient;

/**
 * Returns the start of the current UTC calendar month (e.g. 2026-08-21 ->
 * 2026-08-01T00:00:00.000Z). Pass `date` to compute the period for a
 * specific instant instead of "now" (used by tests, and by any future
 * caller that needs to report/backfill against a past period).
 *
 * Deliberately UTC, not the server's local timezone: the server's TZ is an
 * environment detail that must not change what "this month" means for
 * usage/quota accounting.
 */
export function getPeriodStart(date: Date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * Resolves the plan whose limits currently apply to a user.
 *
 * Subscription.status handling (no billing/Stripe integration exists yet,
 * so this is deliberately the simplest rule the current schema supports,
 * not an arbitrary choice):
 *  - ACTIVE      -> the subscription's plan.
 *  - no Subscription row -> the "free" plan.
 *  - CANCELED / PAST_DUE -> the "free" plan, immediately.
 *
 * Why CANCELED/PAST_DUE don't get any grace period: `Subscription` has no
 * period-end/grace-period field today (no `currentPeriodEnd`, no
 * `gracePeriodEndsAt`) — there is no data in the schema from which to
 * derive "still entitled until X". Inventing a grace window here would be
 * inventing both a rule and the data to back it, which the caller
 * explicitly asked not to do silently. When billing is wired up, a
 * period-end field can be added to `Subscription` and this function
 * updated to consult it — that's a schema change, out of scope here.
 *
 * Never creates a Subscription row as a side effect.
 */
export async function getUserPlan(userId: string, client: PrismaClientOrTx = prisma): Promise<Plan> {
  const subscription = await client.subscription.findUnique({
    where: { userId },
    include: { plan: true },
  });

  if (subscription && subscription.status === "ACTIVE") {
    return subscription.plan;
  }

  const freePlan = await client.plan.findUnique({ where: { key: "free" } });

  if (!freePlan) {
    throw new Error(
      "Plano 'free' não encontrado no banco. Rode o seed (`npx prisma db seed`) antes de usar lib/usage.ts."
    );
  }

  return freePlan;
}

export type UsageCounters = {
  videos: number;
  minutes: number;
  aiAnalyses: number;
  clips: number;
};

const USAGE_TYPE_TO_COUNTER_KEY: Record<UsageType, keyof UsageCounters> = {
  VIDEO_UPLOAD: "videos",
  TRANSCRIPTION_MINUTES: "minutes",
  AI_ANALYSIS: "aiAnalyses",
  CLIP_GENERATED: "clips",
};

function emptyUsageCounters(): UsageCounters {
  return { videos: 0, minutes: 0, aiAnalyses: 0, clips: 0 };
}

/**
 * Sums UsageRecord.amount per UsageType for the current UTC calendar month,
 * via a single grouped aggregation query (not one query per type).
 */
export async function getUsageThisPeriod(
  userId: string,
  now: Date = new Date(),
  client: PrismaClientOrTx = prisma
): Promise<UsageCounters> {
  const periodStart = getPeriodStart(now);

  const grouped = await client.usageRecord.groupBy({
    by: ["type"],
    where: { userId, periodStart },
    _sum: { amount: true },
  });

  const usage = emptyUsageCounters();

  for (const row of grouped) {
    usage[USAGE_TYPE_TO_COUNTER_KEY[row.type]] = row._sum.amount ?? 0;
  }

  return usage;
}

/**
 * Acquires a transaction-scoped row lock on the user's own `User` row via
 * `SELECT ... FOR UPDATE`. Must be called with a transaction's client
 * (`tx` from `prisma.$transaction(async (tx) => ...)`), as the very first
 * statement in that transaction.
 *
 * This is what makes "check quota, then create the thing, then record
 * usage" safe against two concurrent requests from the same user both
 * reading a stale "remaining" count and both being allowed through: the
 * second request's transaction blocks on this lock until the first one
 * commits (or rolls back), so its recount inside checkQuota always sees
 * whatever the first transaction actually persisted. Different users lock
 * different rows and never block each other. No new table, no advisory
 * lock magic number, no Redis — just a lock on a row that already exists
 * for every user.
 */
export async function lockUserForQuota(
  userId: string,
  tx: Prisma.TransactionClient
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
}

/**
 * Pure decision logic behind checkQuota, kept separate so it can be
 * unit-tested without a database (mirrors sanitizeSuggestions/
 * computeTranscriptHash: pure core, thin I/O wrapper around it).
 * `remaining` is always clamped to 0 — "quota already exceeded" is
 * reported as 0 remaining, never a negative number.
 */
export function evaluateQuota(
  used: number,
  limit: number,
  additionalAmount: number
): { allowed: boolean; remaining: number } {
  return {
    allowed: used + additionalAmount <= limit,
    remaining: Math.max(0, limit - used),
  };
}

const USAGE_TYPE_TO_LIMIT_KEY: Record<UsageType, keyof Plan> = {
  VIDEO_UPLOAD: "maxVideosPerMonth",
  TRANSCRIPTION_MINUTES: "maxMinutesPerMonth",
  AI_ANALYSIS: "maxAiAnalysesPerMonth",
  CLIP_GENERATED: "maxClipsPerMonth",
};

export type QuotaCheckResult = {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  type: UsageType;
};

/**
 * Checks whether a user can consume `additionalAmount` more units of
 * `type` this period, without actually consuming it. Never throws for "over
 * quota" — returns `allowed: false` so the caller (a future API route)
 * decides how to respond (403/429/etc). Only throws for a genuine setup
 * problem (e.g. missing "free" plan), same as getUserPlan.
 */
export async function checkQuota(
  userId: string,
  type: UsageType,
  additionalAmount: number = 1,
  client: PrismaClientOrTx = prisma
): Promise<QuotaCheckResult> {
  // Sequential, not Promise.all: when `client` is a transaction's `tx`, it
  // holds a single underlying connection — issuing two queries on it
  // concurrently is unsafe with Prisma's interactive transactions.
  const plan = await getUserPlan(userId, client);
  const usage = await getUsageThisPeriod(userId, new Date(), client);

  const used = usage[USAGE_TYPE_TO_COUNTER_KEY[type]];
  const limit = plan[USAGE_TYPE_TO_LIMIT_KEY[type]] as number;
  const { allowed, remaining } = evaluateQuota(used, limit, additionalAmount);

  return { allowed, used, limit, remaining, type };
}

export type RecordUsageParams = {
  userId: string;
  type: UsageType;
  amount: number;
  periodStart: Date;
  /**
   * Required, never generated here — a random/generated key would defeat
   * idempotency. Callers derive it from the resource the event is about,
   * e.g.:
   *   VIDEO_UPLOAD:<videoId>
   *   TRANSCRIPTION_MINUTES:<videoId>
   *   AI_ANALYSIS:<analysisCacheId>
   *   CLIP_GENERATED:<clipId>
   */
  idempotencyKey: string;
  videoId?: string;
  clipId?: string;
  analysisCacheId?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

/**
 * Appends one event to the UsageRecord ledger. Idempotent via the unique
 * `UsageRecord.idempotencyKey` constraint: re-running this with the same
 * key is a no-op (the existing row is left untouched, not overwritten) —
 * this is a ledger, not a counter, so a retried event must never create a
 * second line for something that already happened once.
 */
export async function recordUsage(
  params: RecordUsageParams,
  client: PrismaClientOrTx = prisma
): Promise<void> {
  if (!params.idempotencyKey) {
    throw new Error("recordUsage requires a non-empty idempotencyKey.");
  }

  await client.usageRecord.upsert({
    where: { idempotencyKey: params.idempotencyKey },
    update: {},
    create: {
      userId: params.userId,
      type: params.type,
      amount: params.amount,
      periodStart: params.periodStart,
      idempotencyKey: params.idempotencyKey,
      videoId: params.videoId,
      clipId: params.clipId,
      analysisCacheId: params.analysisCacheId,
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
      totalTokens: params.totalTokens,
    },
  });
}

export type UsageSummary = {
  plan: {
    key: string;
    name: string;
    maxVideosPerMonth: number;
    maxMinutesPerMonth: number;
    maxAiAnalysesPerMonth: number;
    maxClipsPerMonth: number;
  };
  usage: UsageCounters;
  remaining: UsageCounters;
  periodStart: Date;
};

/** Convenience aggregate for a future usage/quota UI. Not wired to any route yet. */
export async function getUsageSummary(
  userId: string,
  now: Date = new Date()
): Promise<UsageSummary> {
  const periodStart = getPeriodStart(now);
  const [plan, usage] = await Promise.all([
    getUserPlan(userId),
    getUsageThisPeriod(userId, now),
  ]);

  return {
    plan: {
      key: plan.key,
      name: plan.name,
      maxVideosPerMonth: plan.maxVideosPerMonth,
      maxMinutesPerMonth: plan.maxMinutesPerMonth,
      maxAiAnalysesPerMonth: plan.maxAiAnalysesPerMonth,
      maxClipsPerMonth: plan.maxClipsPerMonth,
    },
    usage,
    remaining: {
      videos: evaluateQuota(usage.videos, plan.maxVideosPerMonth, 0).remaining,
      minutes: evaluateQuota(usage.minutes, plan.maxMinutesPerMonth, 0).remaining,
      aiAnalyses: evaluateQuota(usage.aiAnalyses, plan.maxAiAnalysesPerMonth, 0).remaining,
      clips: evaluateQuota(usage.clips, plan.maxClipsPerMonth, 0).remaining,
    },
    periodStart,
  };
}
