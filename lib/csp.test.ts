import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, generateNonce } from "./csp";

describe("buildContentSecurityPolicy", () => {
  it("monta a CSP de produção com nonce, sem unsafe-inline/unsafe-eval", () => {
    expect(buildContentSecurityPolicy("abc123", false)).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'nonce-abc123' 'strict-dynamic'",
        "style-src 'self' 'nonce-abc123'",
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

  it("libera unsafe-eval (script) e unsafe-inline (style) só em desenvolvimento", () => {
    const csp = buildContentSecurityPolicy("abc123", true);
    expect(csp).toContain(
      "script-src 'self' 'nonce-abc123' 'strict-dynamic' 'unsafe-eval'",
    );
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });
});

describe("generateNonce", () => {
  it("gera um valor base64 diferente a cada chamada", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    // Mesmo formato que o Next aceita ao extrair o nonce do header.
    expect(a).toMatch(/^[A-Za-z0-9+/_-]+={0,2}$/);
  });
});
