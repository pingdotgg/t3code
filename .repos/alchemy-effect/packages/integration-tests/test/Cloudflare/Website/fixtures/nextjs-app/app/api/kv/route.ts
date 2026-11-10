import { getCloudflareContext } from "@opennextjs/cloudflare";

// KV round-trip through the FIXTURE_KV resource binding.
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key");
  const { env } = getCloudflareContext();
  const value = key ? await env.FIXTURE_KV.get(key) : null;
  return Response.json({ value });
}

export async function PUT(request: Request) {
  const { key, value } = (await request.json()) as {
    key: string;
    value: string;
  };
  const { env } = getCloudflareContext();
  await env.FIXTURE_KV.put(key, value);
  return Response.json({ ok: true });
}
