import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Reject cross-origin requests to API routes.
 *
 * Without this, any website the user visits could make fetch() calls to
 * the local server and hit state-changing endpoints (kill processes, delete
 * branches, send text to terminals, etc.).
 *
 * We allow requests that either:
 * - Have no Origin header (same-origin navigations, curl, Electron webview)
 * - Have an Origin matching the local server
 */
export function middleware(request: NextRequest) {
  const origin = request.headers.get("origin");

  if (origin) {
    // Same-origin only: the Origin must be this local server itself, whatever
    // port it runs on. Requiring a localhost Host also defeats DNS rebinding.
    const host = request.headers.get("host") ?? "";
    const isLocalHost = /^(localhost|127\.0\.0\.1):\d+$/.test(host);
    if (!isLocalHost || origin !== `http://${host}`) {
      return NextResponse.json({ error: "Forbidden: cross-origin request" }, { status: 403 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
