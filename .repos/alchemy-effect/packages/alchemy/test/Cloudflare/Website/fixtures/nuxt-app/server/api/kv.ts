// KV round-trip through `event.context.cloudflare.env.SITE_KV` — the live
// suite exercises a real KV namespace binding, the dev suite the local
// simulator behind the platform-proxy bridge. GET reads a key, PUT writes.
interface KvBinding {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
}

export default defineEventHandler(async (event) => {
  const env = (
    event.context.cloudflare as { env?: Record<string, unknown> } | undefined
  )?.env;
  const kv = env?.SITE_KV as KvBinding | undefined;
  if (kv === undefined) {
    throw createError({
      statusCode: 500,
      statusMessage: "SITE_KV binding missing",
    });
  }
  const query = getQuery(event);
  const key = typeof query.key === "string" ? query.key : "test-key";
  if (event.method === "PUT") {
    const value = typeof query.value === "string" ? query.value : "";
    await kv.put(key, value);
    return { put: true, key };
  }
  return { key, value: await kv.get(key) };
});
