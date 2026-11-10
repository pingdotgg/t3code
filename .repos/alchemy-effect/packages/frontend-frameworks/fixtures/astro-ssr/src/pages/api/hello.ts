import { env } from "cloudflare:workers";

/** JSON endpoint: reads the Text binding + asserts the ASSETS binding exists. */
export function GET() {
  return Response.json({
    value: (env as Record<string, unknown>).FIXTURE_VALUE ?? null,
    hasAssetsBinding: typeof (env as { ASSETS?: { fetch?: unknown } }).ASSETS?.fetch === "function",
  });
}

/** JSON echo for non-GET methods, proving on-demand API routing under SSR. */
export async function POST({ request }: { request: Request }) {
  const body = (await request.json()) as Record<string, unknown>;
  return Response.json({ echoed: body, method: "POST" });
}
