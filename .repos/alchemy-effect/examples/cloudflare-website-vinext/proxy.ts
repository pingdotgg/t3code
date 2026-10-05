import { NextRequest, NextResponse } from "next/server";
import {
  timezoneFromRequest,
  visitorTimezoneHeader,
} from "./src/VisitorTimezone.ts";

/**
 * Next.js 16 / vinext `proxy.ts` (the `middleware.ts` file convention
 * is deprecated). Trimmed to the routes this Alchemy example ships.
 */
export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/admin") {
    return new Response("Blocked by proxy", { status: 403 });
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(visitorTimezoneHeader(), timezoneFromRequest(request));

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("x-mw-ran", "true");
  return response;
}

export const config = {
  matcher: ["/", "/notes", "/use-cache", "/api/:path*", "/admin"],
};
