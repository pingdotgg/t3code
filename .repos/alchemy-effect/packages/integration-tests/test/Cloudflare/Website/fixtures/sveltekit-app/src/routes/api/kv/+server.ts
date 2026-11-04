import { json } from "@sveltejs/kit";

// Minimal structural type for a Workers KV namespace binding — the fixture
// is type-checked without `@cloudflare/workers-types`.
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

// Local Platform shape — see ../../+page.server.ts.
interface Platform {
  env?: { SITE_KV?: KVNamespace };
}

interface RequestEvent {
  url: URL;
  request: Request;
  platform?: Platform;
}

/**
 * Round-trips a REAL KV namespace binding (`platform.env.SITE_KV`) through
 * server endpoints: `PUT /api/kv?key=k` writes the request body, and
 * `GET /api/kv?key=k` reads it back.
 */
export const GET = async ({ url, platform }: RequestEvent) => {
  const key = url.searchParams.get("key");
  if (!key) {
    return json({ error: "key is required" }, { status: 400 });
  }
  const kv = platform?.env?.SITE_KV;
  if (!kv) {
    return json({ error: "no SITE_KV binding" }, { status: 500 });
  }
  return json({ key, value: await kv.get(key) });
};

export const PUT = async ({ url, request, platform }: RequestEvent) => {
  const key = url.searchParams.get("key");
  if (!key) {
    return json({ error: "key is required" }, { status: 400 });
  }
  const kv = platform?.env?.SITE_KV;
  if (!kv) {
    return json({ error: "no SITE_KV binding" }, { status: 500 });
  }
  await kv.put(key, await request.text());
  return json({ ok: true, key });
};
