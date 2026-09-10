import { getCloudflareContext } from "@opennextjs/cloudflare";

export const dynamic = "force-dynamic";

export function GET() {
  const { env } = getCloudflareContext();
  return Response.json({ value: env.TEST_TEXT ?? null });
}
