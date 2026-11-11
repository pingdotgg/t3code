// Async (non-Effect) Worker that exercises the native R2 binding against
// the local workerd simulator: put / get / head / list / delete.
interface R2ObjectLike {
  key: string;
  etag: string;
  httpEtag: string;
  size: number;
  text(): Promise<string>;
}

interface Env {
  BUCKET: {
    put(
      key: string,
      value: string,
      options?: { httpMetadata?: { contentType?: string } },
    ): Promise<R2ObjectLike>;
    get(key: string): Promise<R2ObjectLike | null>;
    head(key: string): Promise<R2ObjectLike | null>;
    list(): Promise<{ objects: Array<{ key: string; size: number }> }>;
    delete(key: string): Promise<void>;
  };
}

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.pathname === "/seed") {
      // Writes without deleting, so the test can verify out-of-band (via
      // the cloud API for an `Alchemy.remote()` bucket) that the object
      // actually landed in the bound bucket.
      await env.BUCKET.put("seed.txt", "seeded by worker", {
        httpMetadata: { contentType: "text/plain" },
      });
      const head = await env.BUCKET.head("seed.txt");
      return Response.json({ etag: head?.etag ?? null });
    }
    if (url.pathname === "/roundtrip") {
      await env.BUCKET.put("greeting.txt", "hello r2", {
        httpMetadata: { contentType: "text/plain" },
      });
      const obj = await env.BUCKET.get("greeting.txt");
      const text = obj === null ? null : await obj.text();
      const head = await env.BUCKET.head("greeting.txt");
      const list = await env.BUCKET.list();
      await env.BUCKET.delete("greeting.txt");
      const afterDelete = await env.BUCKET.get("greeting.txt");
      return Response.json({
        text,
        etag: head?.etag ?? null,
        size: head?.size ?? null,
        keys: list.objects.map((o) => o.key),
        afterDelete: afterDelete === null,
      });
    }
    if (url.pathname === "/get") {
      const obj = await env.BUCKET.get(url.searchParams.get("key") ?? "");
      return Response.json({ text: obj === null ? null : await obj.text() });
    }
    return new Response("not found", { status: 404 });
  },
};
