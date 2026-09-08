// Async (non-Effect) Worker that exercises a native KV binding:
// put / get / getWithMetadata / list / delete. The binding under test is
// selected with `?binding=NAME` (default `KV`) so one worker can exercise
// several namespaces — e.g. a locally-simulated one and an
// `Alchemy.remote()`-opted one side by side.
interface KVNamespaceLike {
  put(
    key: string,
    value: string,
    options?: { metadata?: unknown },
  ): Promise<void>;
  get(key: string): Promise<string | null>;
  getWithMetadata(
    key: string,
  ): Promise<{ value: string | null; metadata: unknown }>;
  list(): Promise<{ keys: Array<{ name: string }> }>;
  delete(key: string): Promise<void>;
}

type Env = Record<string, KVNamespaceLike>;

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    const kv = env[url.searchParams.get("binding") ?? "KV"];
    if (url.pathname === "/roundtrip") {
      await kv.put("key1", "value1");
      await kv.put("key2", "value2", { metadata: { hello: "world" } });
      const value = await kv.get("key1");
      const { value: value2, metadata } = await kv.getWithMetadata("key2");
      const list = await kv.list();
      await kv.delete("key1");
      const afterDelete = await kv.get("key1");
      return Response.json({
        value,
        value2,
        metadata,
        keys: list.keys.map((k) => k.name),
        afterDelete,
      });
    }
    if (url.pathname === "/get") {
      const value = await kv.get(url.searchParams.get("key") ?? "");
      return Response.json({ value });
    }
    return new Response("not found", { status: 404 });
  },
};
