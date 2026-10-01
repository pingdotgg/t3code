import { env } from "cloudflare:workers";
import type { APIContext } from "astro";

export const prerender = false;

/**
 * GET/PUT against the user-declared `SITE_KV` binding through the runtime
 * env — a REAL KV namespace bound via `env: { SITE_KV: ... }` in the test
 * (local simulator or remote-proxied live namespace in dev).
 */
interface KVBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

const kv = () => (env as { SITE_KV?: KVBinding }).SITE_KV;

export async function GET({ url }: APIContext) {
  const key = url.searchParams.get("key") ?? "";
  const value = (await kv()?.get(key)) ?? null;
  return Response.json({ value });
}

export async function PUT({ url }: APIContext) {
  const key = url.searchParams.get("key") ?? "";
  const value = url.searchParams.get("value") ?? "";
  await kv()?.put(key, value);
  return Response.json({ ok: true, key, value });
}
