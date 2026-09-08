// KV round-trip through `event.context.cloudflare.env` — the dev suite
// exercises it over the platform-proxy bridge (nitro's dev worker thread →
// the host's workerd instance), the live suite over miniflare's KV.
interface KvBinding {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
}

export default defineEventHandler(async (event) => {
  const env = (event.context.cloudflare as { env?: Record<string, unknown> } | undefined)?.env;
  const kv = env?.FIXTURE_KV as KvBinding | undefined;
  if (kv === undefined) {
    throw createError({ statusCode: 500, statusMessage: "FIXTURE_KV binding missing" });
  }
  const query = getQuery(event);
  const key = typeof query.key === "string" ? query.key : "e2e-key";
  if (event.method === "POST") {
    const value = typeof query.value === "string" ? query.value : "";
    await kv.put(key, value);
    return { put: true, key };
  }
  return { key, value: await kv.get(key) };
});
