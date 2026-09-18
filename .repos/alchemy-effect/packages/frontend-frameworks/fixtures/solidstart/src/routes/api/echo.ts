import type { APIEvent } from "@solidjs/start/server";

// Minimal API route: proves server-side route handlers execute in the worker
// (live) / the SSR dev server (dev), including a POST round-trip.
export function GET() {
  return Response.json({ method: "GET", server: true });
}

export async function POST(event: APIEvent) {
  const body = (await event.request.json()) as unknown;
  return Response.json({ method: "POST", echoed: body });
}
