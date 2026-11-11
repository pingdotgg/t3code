import { getCloudflareContext } from "@opennextjs/cloudflare";

// Reads the TEST_TEXT env binding through OpenNext's getCloudflareContext()
// — proves resource bindings reach route handlers (deploy, preview, and hmr).
export function GET() {
  const { env } = getCloudflareContext();
  return Response.json({ value: env.TEST_TEXT ?? null });
}
