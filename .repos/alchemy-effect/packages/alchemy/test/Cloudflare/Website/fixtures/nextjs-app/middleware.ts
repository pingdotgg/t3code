import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const url = new URL(request.url);
  if (url.pathname === "/mw-rewrite") {
    const rewritten = new URL("/api/hello", request.url);
    return NextResponse.rewrite(rewritten, {
      headers: { "x-fixture-middleware": "rewrote" },
    });
  }
  const response = NextResponse.next();
  response.headers.set("x-fixture-middleware", "passed");
  return response;
}

export const config = {
  matcher: ["/mw-rewrite", "/api/:path*"],
};
