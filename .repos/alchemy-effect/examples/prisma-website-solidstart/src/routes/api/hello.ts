import type { APIEvent } from "@solidjs/start/server";

export function GET({ request }: APIEvent) {
  return Response.json({
    name: new URL(request.url).searchParams.get("name") ?? "visitor",
    greeting: process.env.GREETING ?? "Hello!",
  });
}
