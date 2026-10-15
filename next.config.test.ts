import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

async function getHeaderRules() {
  if (typeof nextConfig.headers !== "function") {
    throw new Error("next.config.ts deve exportar headers() como função");
  }
  return nextConfig.headers();
}

function findHeader(headers: { key: string; value: string }[], key: string) {
  return headers.find((header) => header.key === key);
}

describe("security headers (next.config.ts)", () => {
  it("aplica as regras a todas as rotas via source '/:path*' e a CSP de API em '/api/:path*'", async () => {
    const rules = await getHeaderRules();
    expect(rules).toHaveLength(2);
    expect(rules[0].source).toBe("/:path*");
    expect(rules[1].source).toBe("/api/:path*");
  });

  it("define X-Content-Type-Options: nosniff", async () => {
    const [rule] = await getHeaderRules();
    expect(findHeader(rule.headers, "X-Content-Type-Options")?.value).toBe(
      "nosniff",
    );
  });

  it("define Referrer-Policy: strict-origin-when-cross-origin", async () => {
    const [rule] = await getHeaderRules();
    expect(findHeader(rule.headers, "Referrer-Policy")?.value).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("define X-Frame-Options: DENY", async () => {
    const [rule] = await getHeaderRules();
    expect(findHeader(rule.headers, "X-Frame-Options")?.value).toBe("DENY");
  });

  it("define Permissions-Policy: camera=(), microphone=()", async () => {
    const [rule] = await getHeaderRules();
    expect(findHeader(rule.headers, "Permissions-Policy")?.value).toBe(
      "camera=(), microphone=()",
    );
  });

  it("não define CSP estática em '/:path*' (páginas recebem CSP com nonce via proxy.ts)", async () => {
    const [rule] = await getHeaderRules();
    expect(findHeader(rule.headers, "Content-Security-Policy")).toBeUndefined();
  });

  it("define a Content-Security-Policy completa nas rotas de API", async () => {
    const [, apiRule] = await getHeaderRules();
    expect(apiRule.headers).toHaveLength(1);
    const csp = findHeader(apiRule.headers, "Content-Security-Policy")?.value;

    expect(csp).toBeDefined();
    expect(csp).toBe(
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' blob: data:",
        "font-src 'self'",
        "media-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
  });

  it("não inclui Strict-Transport-Security, COOP ou COEP", async () => {
    const [rule] = await getHeaderRules();
    expect(findHeader(rule.headers, "Strict-Transport-Security")).toBeUndefined();
    expect(
      findHeader(rule.headers, "Cross-Origin-Opener-Policy"),
    ).toBeUndefined();
    expect(
      findHeader(rule.headers, "Cross-Origin-Embedder-Policy"),
    ).toBeUndefined();
  });

  it("mantém output: standalone", () => {
    expect(nextConfig.output).toBe("standalone");
  });
});
