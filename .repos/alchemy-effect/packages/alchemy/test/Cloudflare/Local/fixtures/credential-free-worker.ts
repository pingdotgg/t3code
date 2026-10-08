import type {
  D1Database,
  KVNamespace,
  R2Bucket,
} from "@cloudflare/workers-types";

export default {
  async fetch(
    _request: Request,
    env: { KV: KVNamespace; BUCKET: R2Bucket; DB: D1Database },
  ) {
    return Response.json({
      kv: await env.KV.get("seed"),
      r2: await (await env.BUCKET.get("seed"))?.text(),
      d1: await env.DB.prepare("SELECT value FROM seed").first("value"),
    });
  },
};
