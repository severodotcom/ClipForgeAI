// Limitador de rate simples, in-memory, local a este processo — mesmo
// modelo do Semaphore em lib/concurrency.ts: adequado para o beta
// single-instance atual, mas NÃO coordena nada entre múltiplas
// instâncias/processos. Se o app rodar em mais de uma instância, cada uma
// tem seu próprio contador e o limite efetivo por usuário vira
// `limite × nº de instâncias` — ver auditoria de P2a antes de escalar
// horizontalmente (nesse ponto isto precisaria virar um storage
// compartilhado, ex: Redis).
//
// Fixed window (não sliding): a contagem de uma chave zera de uma vez a
// cada `windowMs`, não decai continuamente — mesma escolha de simplicidade
// que o próprio rate limiter nativo do better-auth usa (ver
// node_modules/better-auth/dist/api/rate-limiter/index.mjs), suficiente
// para conter rajadas de um usuário autenticado sem a complexidade de uma
// janela deslizante.
//
// Cobre só as nossas rotas de API (chave = userId, definida em cada
// route.ts via rateLimitKey). O rate limiting das rotas do better-auth
// (login/registro/reset de senha) é o nativo dele, configurado em
// lib/auth.ts — não duplicado aqui.
export type RateLimitRule = {
  windowMs: number;
  max: number;
};

type Bucket = {
  count: number;
  windowStart: number;
  windowMs: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: number;
};

const globalForRateLimit = globalThis as unknown as {
  rateLimitStore: Map<string, Bucket> | undefined;
};

const store =
  globalForRateLimit.rateLimitStore ?? (globalForRateLimit.rateLimitStore = new Map());

// Remove chaves cuja própria janela já expirou. Roda a cada chamada de
// checkRateLimit (mesmo padrão do pruneMemoryStore do better-auth) — uma
// varredura O(n) do mapa inteiro, mas o mapa aqui é pequeno por natureza
// (usuários ativos × rotas com limite), então o custo é desprezível nesta
// escala. Nunca afeta a janela de uma chave diferente da que expirou.
function pruneExpired(now: number) {
  for (const [key, bucket] of store) {
    if (now - bucket.windowStart >= bucket.windowMs) {
      store.delete(key);
    }
  }
}

/**
 * Decide, de forma atômica (sem `await` no meio — JS é single-thread, então
 * leitura+escrita do bucket aqui não é interrompida por outra requisição),
 * se `key` pode consumir mais uma requisição dentro de `rule`.
 *
 * `now` é injetável só para testes determinísticos (mesmo padrão usado em
 * `reconcileStuckOperations`); em produção sempre usa o relógio real
 * (default).
 */
export function checkRateLimit(
  key: string,
  rule: RateLimitRule,
  now: number = Date.now()
): RateLimitDecision {
  pruneExpired(now);

  const bucket = store.get(key);

  if (!bucket || now - bucket.windowStart >= rule.windowMs) {
    store.set(key, { count: 1, windowStart: now, windowMs: rule.windowMs });

    return {
      allowed: true,
      limit: rule.max,
      remaining: Math.max(0, rule.max - 1),
      retryAfterSeconds: 0,
      resetAt: now + rule.windowMs,
    };
  }

  const resetAt = bucket.windowStart + rule.windowMs;

  if (bucket.count >= rule.max) {
    return {
      allowed: false,
      limit: rule.max,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      resetAt,
    };
  }

  bucket.count += 1;

  return {
    allowed: true,
    limit: rule.max,
    remaining: Math.max(0, rule.max - bucket.count),
    retryAfterSeconds: 0,
    resetAt,
  };
}

/**
 * Resposta 429 padrão para qualquer rota que use checkRateLimit — mesmo
 * formato de erro (`error` + `code`) já usado para QUOTA_EXCEEDED, mais os
 * headers padronizados aprovados para o beta. Só deve ser chamada quando
 * `decision.allowed === false`.
 *
 * `RateLimit-Reset` aqui é "segundos até a janela liberar de novo" (mesma
 * unidade de `Retry-After`), não um timestamp absoluto — escolha
 * deliberada para não introduzir uma segunda convenção de header no mesmo
 * response.
 */
export function rateLimitResponse(decision: RateLimitDecision): Response {
  return Response.json(
    {
      error: "Muitas requisições em um curto período. Tente novamente em instantes.",
      code: "RATE_LIMITED",
    },
    {
      status: 429,
      headers: {
        "Retry-After": decision.retryAfterSeconds.toString(),
        "RateLimit-Limit": decision.limit.toString(),
        "RateLimit-Remaining": decision.remaining.toString(),
        "RateLimit-Reset": decision.retryAfterSeconds.toString(),
      },
    }
  );
}

/**
 * Regras aprovadas para o beta (ver auditoria de P2a). Cada rota importa a
 * regra correspondente em vez de números soltos, então o valor real do
 * limite fica documentado num único lugar. "CLIP_GENERATION" é
 * compartilhada entre criar um clipe (POST) e editar o intervalo de um
 * clipe existente (PATCH, quando isso reprocessa via ffmpeg) — ambas as
 * ações custam o mesmo (uma execução de ffmpeg), então dividem o mesmo
 * orçamento em vez de cada uma ter o seu.
 */
export const RATE_LIMIT_RULES = {
  VIDEO_UPLOAD: { windowMs: 10 * 60 * 1000, max: 10 },
  AI_SUGGESTIONS: { windowMs: 10 * 60 * 1000, max: 10 },
  VIDEO_RETRY: { windowMs: 10 * 60 * 1000, max: 5 },
  CLIP_RETRY: { windowMs: 10 * 60 * 1000, max: 5 },
  CLIP_GENERATION: { windowMs: 10 * 60 * 1000, max: 20 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Chave padrão: `${scope}:${userId}`. Nunca IP nestas rotas — todas exigem
 * sessão antes de chegar aqui, e o `userId` é a fronteira de identidade
 * correta para um usuário já autenticado (ver auditoria de P2a: IP
 * penalizaria NAT compartilhado e não impediria nada, já que um usuário
 * pode ter vários IPs).
 */
export function rateLimitKey(scope: string, userId: string): string {
  return `${scope}:${userId}`;
}
