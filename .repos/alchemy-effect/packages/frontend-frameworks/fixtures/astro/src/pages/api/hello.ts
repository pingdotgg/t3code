import { env } from "cloudflare:workers";

export const prerender = false;

export function GET() {
  return Response.json({
    value: (env as Record<string, unknown>).FIXTURE_VALUE ?? null,
    hasAssetsBinding: typeof (env as { ASSETS?: { fetch?: unknown } }).ASSETS?.fetch === "function",
  });
}
