import { readEnv } from "../../../env.ts";

// Served at `/api/kv` (the `_api` prefix is stripped, nested directories are
// kept). Reads and writes through the `SITE_KV` namespace binding from the
// `cloudflare:workers` env at request time — proving a real resource binding
// (not just a plain-string var) reaches waku's API routes.

type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

const kv = async (): Promise<KVNamespace | undefined> => {
  const env = await readEnv();
  return env.SITE_KV as KVNamespace | undefined;
};

export const GET = async (request: Request): Promise<Response> => {
  const namespace = await kv();
  if (!namespace) {
    return Response.json({ error: "SITE_KV is not bound" }, { status: 500 });
  }
  const key = new URL(request.url).searchParams.get("key") ?? "";
  const value = await namespace.get(key);
  return Response.json({ key, value });
};

export const PUT = async (request: Request): Promise<Response> => {
  const namespace = await kv();
  if (!namespace) {
    return Response.json({ error: "SITE_KV is not bound" }, { status: 500 });
  }
  const { key, value } = (await request.json()) as {
    key: string;
    value: string;
  };
  await namespace.put(key, value);
  return Response.json({ ok: true, key });
};
