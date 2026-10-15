import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "./proxy";

const SESSION_COOKIE = "better-auth.session_token=fake-token";

function request(path: string, cookie?: string) {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie } : {},
  });
}

function nonceFrom(csp: string | null) {
  return csp?.match(/'nonce-([^']+)'/)?.[1];
}

describe("proxy (CSP com nonce)", () => {
  it("define a CSP com nonce na resposta e no request repassado ao Next", () => {
    const response = proxy(request("/register"));
    const csp = response.headers.get("Content-Security-Policy");
    const nonce = nonceFrom(csp);

    expect(nonce).toBeDefined();
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");

    // NextResponse.next({ request: { headers } }) expõe os headers
    // sobrescritos do request como x-middleware-request-*.
    expect(
      response.headers.get("x-middleware-request-content-security-policy"),
    ).toBe(csp);
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
  });

  it("gera um nonce diferente a cada request", () => {
    const a = nonceFrom(
      proxy(request("/register")).headers.get("Content-Security-Policy"),
    );
    const b = nonceFrom(
      proxy(request("/register")).headers.get("Content-Security-Policy"),
    );
    expect(a).not.toBe(b);
  });

  it("mantém o redirect de /dashboard sem sessão para /login", () => {
    const response = proxy(request("/dashboard/projects/1"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("mantém o redirect de /login e /register com sessão para /dashboard", () => {
    for (const path of ["/login", "/register"]) {
      const response = proxy(request(path, SESSION_COOKIE));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/dashboard",
      );
    }
  });

  it("deixa /dashboard com sessão seguir, com CSP", () => {
    const response = proxy(request("/dashboard", SESSION_COOKIE));
    expect(response.headers.get("location")).toBeNull();
    expect(nonceFrom(response.headers.get("Content-Security-Policy"))).toBeDefined();
  });
});

describe("proxy matcher", () => {
  const [matcher] = config.matcher;
  const regex = new RegExp(`^${matcher}$`);

  it.each(["/", "/login", "/register", "/dashboard", "/dashboard/projects/1"])(
    "cobre a página %s",
    (path) => expect(regex.test(path)).toBe(true),
  );

  it.each(["/api/auth/sign-up/email", "/_next/static/chunks/a.js", "/_next/image", "/favicon.ico"])(
    "não cobre %s",
    (path) => expect(regex.test(path)).toBe(false),
  );
});
