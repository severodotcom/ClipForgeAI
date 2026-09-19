import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkRateLimit, rateLimitResponse, type RateLimitRule } from "@/lib/rate-limit";

// Cada teste usa uma chave aleatória própria (randomUUID) em vez de
// resetar o Map interno do módulo — o store é um singleton global (mesmo
// truque de lib/concurrency.ts), então isolar por chave é mais simples e
// mais parecido com o uso real (cada usuário é uma chave diferente) do que
// expor um hook de reset só para teste.
const RULE: RateLimitRule = { windowMs: 10_000, max: 3 };

function uniqueKey(label: string) {
  return `${label}:${randomUUID()}`;
}

describe("checkRateLimit (lib/rate-limit.ts)", () => {
  it("permite requisições dentro do limite, decrementando remaining a cada uma", () => {
    const key = uniqueKey("dentro-do-limite");
    const now = 1_000_000;

    const first = checkRateLimit(key, RULE, now);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(2);

    const second = checkRateLimit(key, RULE, now + 100);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(1);

    const third = checkRateLimit(key, RULE, now + 200);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
  });

  it("bloqueia a partir da requisição que excede o limite", () => {
    const key = uniqueKey("excede-o-limite");
    const now = 2_000_000;

    checkRateLimit(key, RULE, now);
    checkRateLimit(key, RULE, now + 100);
    checkRateLimit(key, RULE, now + 200); // consome a 3ª e última vaga

    const fourth = checkRateLimit(key, RULE, now + 300);
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.limit).toBe(RULE.max);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);

    // Continua bloqueando enquanto a janela não vira — não "libera" sozinho
    // por ser chamado de novo dentro da mesma janela.
    const fifth = checkRateLimit(key, RULE, now + 400);
    expect(fifth.allowed).toBe(false);
  });

  it("libera automaticamente depois que a janela passa", () => {
    const key = uniqueKey("libera-apos-janela");
    const now = 3_000_000;

    checkRateLimit(key, RULE, now);
    checkRateLimit(key, RULE, now + 100);
    checkRateLimit(key, RULE, now + 200);

    const blocked = checkRateLimit(key, RULE, now + 500);
    expect(blocked.allowed).toBe(false);

    // Mesmo 1ms depois do fim da janela original (windowStart + windowMs),
    // a próxima chamada já conta como uma nova janela.
    const afterWindow = now + RULE.windowMs + 1;
    const released = checkRateLimit(key, RULE, afterWindow);

    expect(released.allowed).toBe(true);
    expect(released.remaining).toBe(RULE.max - 1);
    expect(released.resetAt).toBe(afterWindow + RULE.windowMs);
  });

  it("chaves diferentes têm contadores independentes", () => {
    const keyA = uniqueKey("chave-a");
    const keyB = uniqueKey("chave-b");
    const now = 4_000_000;

    // Esgota keyA por completo.
    checkRateLimit(keyA, RULE, now);
    checkRateLimit(keyA, RULE, now + 10);
    checkRateLimit(keyA, RULE, now + 20);
    const aBlocked = checkRateLimit(keyA, RULE, now + 30);
    expect(aBlocked.allowed).toBe(false);

    // keyB nunca foi tocada — deve estar com o limite cheio, sem nenhuma
    // interferência de keyA.
    const bFirst = checkRateLimit(keyB, RULE, now + 40);
    expect(bFirst.allowed).toBe(true);
    expect(bFirst.remaining).toBe(RULE.max - 1);
  });

  it("a limpeza de chaves expiradas (prune) não derruba uma janela ainda ativa de outra chave", () => {
    const active = uniqueKey("janela-ativa");
    const now = 5_000_000;

    // 2 das 3 vagas de `active` consumidas — janela criada em `now`, ainda
    // longe de expirar (windowMs = 10s).
    checkRateLimit(active, RULE, now);
    checkRateLimit(active, RULE, now + 100);

    // Bombardeia o store com muitas OUTRAS chaves cujas janelas expiraram
    // há muito tempo, forçando pruneExpired a de fato remover entradas a
    // cada chamada — se o prune tivesse um bug de escopo (ex: resetar
    // tudo, não só a chave expirada), isso apareceria aqui.
    for (let i = 0; i < 50; i++) {
      const staleKey = uniqueKey(`stale-${i}`);
      checkRateLimit(staleKey, RULE, now - 1_000_000); // cria a janela no passado
      checkRateLimit(staleKey, RULE, now + 200); // dispara pruneExpired(now + 200), que já vê a janela acima expirada
    }

    // A 3ª chamada de `active` ainda deve estar na MESMA janela (contando
    // a partir da 1ª chamada), não resetada para count=1 por engano.
    const third = checkRateLimit(active, RULE, now + 300);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0); // 3ª de 3 — confirma que era a 3ª, não uma janela nova

    const fourth = checkRateLimit(active, RULE, now + 400);
    expect(fourth.allowed).toBe(false); // se a janela tivesse sido resetada, isto passaria
  });

  it("decision carrega limit/remaining/retryAfterSeconds corretos para montar os headers", () => {
    const key = uniqueKey("headers");
    const now = 6_000_000;

    checkRateLimit(key, RULE, now);
    checkRateLimit(key, RULE, now + 1_000);
    checkRateLimit(key, RULE, now + 2_000);

    const blocked = checkRateLimit(key, RULE, now + 3_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.limit).toBe(3);
    expect(blocked.remaining).toBe(0);
    // resetAt = windowStart (now) + windowMs; retryAfterSeconds arredonda
    // pra cima o tempo restante até lá a partir do momento da checagem.
    expect(blocked.resetAt).toBe(now + RULE.windowMs);
    expect(blocked.retryAfterSeconds).toBe(
      Math.ceil((blocked.resetAt - (now + 3_000)) / 1000)
    );
  });

  it("rateLimitResponse produz um 429 com error/code e os headers Retry-After/RateLimit-*", async () => {
    const key = uniqueKey("response");
    const now = 7_000_000;

    checkRateLimit(key, RULE, now);
    checkRateLimit(key, RULE, now + 100);
    checkRateLimit(key, RULE, now + 200);
    const decision = checkRateLimit(key, RULE, now + 300);

    expect(decision.allowed).toBe(false);

    const response = rateLimitResponse(decision);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(decision.retryAfterSeconds.toString());
    expect(response.headers.get("RateLimit-Limit")).toBe(decision.limit.toString());
    expect(response.headers.get("RateLimit-Remaining")).toBe(decision.remaining.toString());
    expect(response.headers.get("RateLimit-Reset")).toBe(decision.retryAfterSeconds.toString());

    const body = await response.json();
    expect(body.code).toBe("RATE_LIMITED");
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });
});
