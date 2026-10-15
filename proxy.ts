import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { buildContentSecurityPolicy, generateNonce } from "@/lib/csp";

const AUTH_ROUTES = ["/login", "/register"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const sessionCookie = getSessionCookie(request);

  const isDashboardRoute =
    pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  const isAuthRoute = AUTH_ROUTES.includes(pathname);

  if (isDashboardRoute && !sessionCookie) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (isAuthRoute && sessionCookie) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  const nonce = generateNonce();
  const contentSecurityPolicy = buildContentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === "development",
  );

  // O Next extrai o nonce do header CSP do request durante o render.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

export const config = {
  // Todas as páginas, exceto rotas de API (CSP estática em next.config.ts)
  // e assets estáticos, que não precisam de nonce.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
