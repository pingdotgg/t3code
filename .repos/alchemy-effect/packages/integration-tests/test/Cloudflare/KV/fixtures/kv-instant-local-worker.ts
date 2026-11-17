// Deliberately use the raw API to verify runtime restrictions, beyond TS types.
interface Namespace {
  put(key: string, value: string, options?: { metadata?: unknown }): Promise<void>;
  get(key: string): Promise<string | null>;
  getWithMetadata(key: string): Promise<{ metadata: unknown }>;
  list(options?: { prefix?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
  }>;
  delete(key: string): Promise<void>;
}

export default {
  async fetch(request: Request, env: { KV: Namespace }) {
    const kv = env.KV;
    const url = new URL(request.url);
    if (url.pathname === "/get") {
      return Response.json({ value: await kv.get(url.searchParams.get("key") ?? "seeded") });
    }
    await kv.put("value", "hello");
    const value = await kv.get("value");
    const { metadata } = await kv.getWithMetadata("value");
    let metadataRejected = false;
    try {
      await kv.put("metadata", "invalid", { metadata: { unsupported: true } });
    } catch {
      metadataRejected = true;
    }
    let longKeyRejected = false;
    try {
      await kv.put("a".repeat(301), "invalid");
    } catch {
      longKeyRejected = true;
    }
    // Cross classic KV's 1,000-key page boundary.
    for (let offset = 0; offset < 1001; offset += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, 1001 - offset) }, (_, index) =>
          kv.put(`config:${offset + index}`, "1"),
        ),
      );
    }
    const listed = await kv.list({ prefix: "config:" });
    await kv.delete("value");
    return Response.json({
      value,
      metadata,
      metadataRejected,
      longKeyRejected,
      count: listed.keys.length,
      complete: listed.list_complete,
      afterDelete: await kv.get("value"),
    });
  },
};
