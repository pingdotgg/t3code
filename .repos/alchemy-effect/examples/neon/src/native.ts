import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { neon } from "@neondatabase/serverless";
import { makeAuthenticate } from "./authenticate.ts";
import { corsHeaders, objectKey, parseUpload, UUID } from "./policy.ts";

const sql = neon(process.env.DATABASE_URL!);
const bucket = process.env.UPLOAD_BUCKET!;
const storage = new S3Client({
  endpoint: process.env.AWS_ENDPOINT_URL_S3!,
  region: process.env.AWS_REGION!,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});
const authenticate = makeAuthenticate(
  process.env.AUTH_URL!,
  process.env.AUTH_JWKS_URL!,
);

async function processUpload(request: Request) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const invocation = request.headers.get("x-neon-trigger-invocation-id");
  if (!invocation)
    return new Response("Missing Neon trigger attestation", { status: 403 });
  const event = await request.json().catch(() => undefined);
  if (
    event?.version !== 1 ||
    event?.trigger?.type !== "storage_object_created" ||
    event?.trigger?.name !== (process.env.TRIGGER_NAME ?? "ProcessUploads") ||
    event?.data?.bucket_name !== bucket ||
    typeof event?.data?.object_key !== "string" ||
    !event.data.object_key.startsWith("incoming/")
  ) {
    return new Response("Invalid object event", { status: 400 });
  }
  if (event.invocation_id !== invocation)
    return new Response("Invocation mismatch", { status: 403 });
  // Neon strips caller-supplied X-Neon-* headers at its edge. This is not a local-server trust boundary.
  const object = await storage.send(
    new HeadObjectCommand({ Bucket: bucket, Key: event.data.object_key }),
  );
  const bytes = object.ContentLength ?? 0;
  await sql`
    WITH delivery AS (
      INSERT INTO upload_events (invocation_id, object_key)
      VALUES (${invocation}, ${event.data.object_key})
      ON CONFLICT DO NOTHING RETURNING invocation_id
    )
    UPDATE uploads SET actual_bytes = ${bytes}, processed_at = now(),
      status = CASE WHEN expected_bytes = ${bytes} AND content_type = ${object.ContentType ?? ""}
        THEN 'ready' ELSE 'rejected' END
    WHERE object_key = ${event.data.object_key} AND EXISTS (SELECT 1 FROM delivery)
  `;
  return new Response(null, { status: 204 });
}

export default {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    const headers = corsHeaders(
      request.headers.get("origin"),
      process.env.APP_ORIGIN,
    );
    try {
      if (path === "/jobs/upload") return await processUpload(request);
      if (!headers) return new Response("Untrusted origin", { status: 403 });
      const respond = (value: unknown, status = 200) =>
        Response.json(value, { status, headers });
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      if (path === "/health") return respond({ ok: true, runtime: "native" });
      const owner = await authenticate(request.headers.get("authorization"));
      if (!owner)
        return respond(
          {
            error: "Sign in again: your token is missing, invalid, or expired.",
          },
          401,
        );
      if (path === "/api/me" && request.method === "GET")
        return respond({ userId: owner });
      if (path === "/api/settings" && request.method === "GET") {
        const settings = await storage.send(
          new GetObjectCommand({ Bucket: bucket, Key: "config/settings.json" }),
        );
        return respond(
          JSON.parse((await settings.Body?.transformToString()) ?? "null"),
        );
      }
      if (path === "/api/uploads" && request.method === "GET") {
        return respond(
          await sql`
          SELECT id, filename, object_key, content_type, expected_bytes, actual_bytes, status, created_at
          FROM uploads WHERE owner_id = ${owner} ORDER BY created_at DESC LIMIT 100
        `,
        );
      }
      if (path === "/api/uploads" && request.method === "POST") {
        const input = parseUpload(await request.json().catch(() => undefined));
        if (!input)
          return respond(
            {
              error:
                "Choose a nonempty file up to 10 MiB with a valid content type.",
            },
            400,
          );
        const id = crypto.randomUUID();
        const key = objectKey(owner, id);
        const url = await getSignedUrl(
          storage,
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ContentType: input.contentType,
          }),
          { expiresIn: 120 },
        );
        await sql`
          INSERT INTO uploads (id, owner_id, object_key, filename, content_type, expected_bytes)
          VALUES (${id}, ${owner}, ${key}, ${input.filename}, ${input.contentType}, ${input.size})
        `;
        return respond({ id, url, contentType: input.contentType }, 201);
      }
      const match = /^\/api\/uploads\/([^/]+)\/download$/.exec(path);
      if (match && request.method === "GET") {
        if (!UUID.test(match[1]!)) return respond({ error: "Not found" }, 404);
        const [row] =
          await sql`SELECT * FROM uploads WHERE id = ${match[1]!} AND owner_id = ${owner}`;
        if (!row) return respond({ error: "Not found" }, 404);
        if (row.status !== "ready")
          return respond(
            { error: "This upload is not ready to download." },
            409,
          );
        const url = await getSignedUrl(
          storage,
          new GetObjectCommand({ Bucket: bucket, Key: row.object_key }),
          { expiresIn: 60 },
        );
        return respond({ url });
      }
      return respond({ error: "Not found" }, 404);
    } catch {
      console.error("Upload API request failed");
      return new Response("Upload service unavailable. Retry the request.", {
        status: 500,
        headers,
      });
    }
  },
};
