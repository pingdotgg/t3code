import type { R2Bucket } from "@cloudflare/workers-types";
import type * as Cloudflare from "@/Cloudflare/index.ts";
import { AwsClient } from "aws4fetch";

interface Env {
  BUCKET: R2Bucket;
  /** `Cloudflare.R2.S3Credentials(bucket, { access: "read-write" })` — a JSON string. */
  BUCKET_S3: string;
}

/**
 * Async (non-Effect) Worker that presigns with `aws4fetch` over
 * `Cloudflare.R2.S3Credentials`. Same routes as `routes.ts`, so the shared
 * `presignRoundTrip` drives it; the same code runs in dev and deployed.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") ?? "";
    const contentType = url.searchParams.get("contentType") ?? undefined;
    switch (url.pathname) {
      case "/presign-put":
        return Response.json({
          url: await presign(env, key, "PUT", {
            headers: contentType ? { "content-type": contentType } : undefined,
          }),
        });
      case "/presign-get":
        return Response.json({
          url: await presign(env, key, "GET", {
            query: contentType
              ? { "response-content-type": contentType }
              : undefined,
          }),
        });
      case "/read": {
        const object = await env.BUCKET.get(key);
        return Response.json({
          value: object === null ? null : await object.text(),
          contentType: object?.httpMetadata?.contentType ?? null,
        });
      }
      case "/write":
        await env.BUCKET.put(key, await request.text());
        return new Response("ok");
      default:
        return new Response("ok");
    }
  },
};

const presign = async (
  env: Env,
  key: string,
  method: "GET" | "PUT",
  options: {
    headers?: Record<string, string>;
    query?: Record<string, string>;
  },
) => {
  const s3: Cloudflare.R2.S3CredentialsValue = JSON.parse(env.BUCKET_S3);
  const client = new AwsClient({ ...s3, service: "s3" });
  const url = new URL(
    `${s3.endpoint}/${encodeURIComponent(s3.bucketName)}/${key
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  );
  for (const [name, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(name, value);
  }
  url.searchParams.set("X-Amz-Expires", "900");
  const signed = await client.sign(url.toString(), {
    method,
    headers: options.headers,
    aws: { signQuery: true, allHeaders: options.headers !== undefined },
  });
  return signed.url;
};
