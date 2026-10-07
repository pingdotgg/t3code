import * as Neon from "alchemy/Neon";
import * as SQL from "alchemy/SQL/Postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { makeAuthenticate } from "./authenticate.ts";
import {
  corsHeaders,
  objectKey,
  parseUpload,
  serializeUploadRow,
  UUID,
  type UploadRecord,
} from "./policy.ts";
import { resources } from "./resources.ts";

export default class Api extends Neon.Function<Api>()(
  "Api",
  Effect.gen(function* () {
    const { branch, auth, appOrigin } = yield* resources;
    return {
      branch,
      main: import.meta.url,
      env: {
        AUTH_URL: auth.baseUrl,
        AUTH_JWKS_URL: auth.jwksUrl,
        APP_ORIGIN: appOrigin,
      },
    };
  }),
  Effect.gen(function* () {
    const { branch, uploads, auth, settings } = yield* resources;
    const connection = yield* Neon.ConnectAuth(auth);
    const defaults = yield* Neon.ReadObject(settings);
    const db = yield* Neon.Connect(branch);
    const sql = yield* SQL.Postgres({ url: db.connectionString });
    const files = yield* Neon.ReadWriteBucket(uploads);
    const env = yield* Neon.FunctionEnvironment;
    // Configuration only: the remote key set performs I/O lazily during verification.
    const authenticate = yield* Effect.cached(
      Effect.gen(function* () {
        const baseUrl = yield* connection.baseUrl;
        const jwksUrl = yield* connection.jwksUrl;
        return yield* Effect.sync(() => makeAuthenticate(baseUrl, jwksUrl));
      }),
    );

    yield* Neon.BucketEventSource(
      uploads,
      {
        name: "ProcessUploads",
        prefix: "incoming/",
      },
      Effect.fn(function* (event) {
        const object = yield* files.head(event.objectKey);
        if (!object)
          return yield* Effect.fail(
            new Error("Uploaded object is not readable yet"),
          );
        const bytes = object.ContentLength ?? 0;
        // Record delivery and transition the row atomically; duplicate invocations do no work.
        yield* sql`
          WITH delivery AS (
            INSERT INTO upload_events (invocation_id, object_key)
            VALUES (${event.invocationId}, ${event.objectKey})
            ON CONFLICT DO NOTHING RETURNING invocation_id
          )
          UPDATE uploads SET actual_bytes = ${bytes}, processed_at = now(),
            status = CASE WHEN expected_bytes = ${bytes} AND content_type = ${object.ContentType ?? ""}
              THEN 'ready' ELSE 'rejected' END
          WHERE object_key = ${event.objectKey} AND EXISTS (SELECT 1 FROM delivery)
        `;
      }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* Neon.FunctionRequest;
        const headers = corsHeaders(
          request.headers.get("origin"),
          env.APP_ORIGIN,
        );
        if (!headers)
          return HttpServerResponse.text("Untrusted origin", { status: 403 });
        const respond = (value: unknown, status = 200) =>
          HttpServerResponse.json(value, { status, headers });
        if (request.method === "OPTIONS")
          return HttpServerResponse.empty({ status: 204, headers });
        const path = yield* Effect.sync(() => new URL(request.url).pathname);
        if (path === "/health")
          return yield* respond({ ok: true, runtime: "effect" });
        const verify = yield* authenticate;
        const owner = yield* Effect.tryPromise(() =>
          verify(request.headers.get("authorization")),
        );
        if (!owner)
          return yield* respond(
            {
              error:
                "Sign in again: your token is missing, invalid, or expired.",
            },
            401,
          );

        if (path === "/api/settings" && request.method === "GET")
          return yield* respond(yield* defaults.get());
        if (path === "/api/me" && request.method === "GET")
          return yield* respond({ userId: owner });
        if (path === "/api/uploads" && request.method === "GET") {
          const rows = yield* sql<UploadRecord>`
            SELECT id, filename, object_key, content_type, expected_bytes, actual_bytes, status, created_at
            FROM uploads WHERE owner_id = ${owner} ORDER BY created_at DESC LIMIT 100
          `;
          return yield* respond(
            yield* Effect.sync(() => rows.map(serializeUploadRow)),
          );
        }
        if (path === "/api/uploads" && request.method === "POST") {
          const json = yield* Effect.tryPromise(() => request.json()).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          const input = parseUpload(json);
          if (!input)
            return yield* respond(
              {
                error:
                  "Choose a nonempty file up to 10 MiB with a valid content type.",
              },
              400,
            );
          const id = yield* Effect.sync(() => crypto.randomUUID());
          const key = objectKey(owner, id);
          const url = yield* files.presignPut(key, {
            contentType: input.contentType,
            expiresIn: 120,
          });
          yield* sql`
            INSERT INTO uploads (id, owner_id, object_key, filename, content_type, expected_bytes)
            VALUES (${id}, ${owner}, ${key}, ${input.filename}, ${input.contentType}, ${input.size})
          `;
          return yield* respond(
            { id, url, contentType: input.contentType },
            201,
          );
        }
        const match = /^\/api\/uploads\/([^/]+)\/download$/.exec(path);
        if (match && request.method === "GET") {
          if (!UUID.test(match[1]!))
            return yield* respond({ error: "Not found" }, 404);
          const [row] =
            yield* sql<UploadRecord>`SELECT * FROM uploads WHERE id = ${match[1]!} AND owner_id = ${owner}`;
          if (!row) return yield* respond({ error: "Not found" }, 404);
          if (row.status !== "ready")
            return yield* respond(
              { error: "This upload is not ready to download." },
              409,
            );
          return yield* respond({
            url: yield* files.presignGet(row.object_key, { expiresIn: 60 }),
          });
        }
        return yield* respond({ error: "Not found" }, 404);
      }).pipe(
        Effect.catchCause(() =>
          Effect.gen(function* () {
            yield* Effect.logError("Upload API request failed");
            const request = yield* Neon.FunctionRequest;
            const headers = corsHeaders(
              request.headers.get("origin"),
              env.APP_ORIGIN,
            );
            return HttpServerResponse.text(
              "Upload service unavailable. Retry the request.",
              { status: 500, headers },
            );
          }),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Neon.ConnectHttp,
        Neon.ConnectAuthHttp,
        Neon.ReadObjectHttp,
        Neon.ReadWriteBucketHttp,
        Neon.BucketEventSourceHttp,
      ),
    ),
  ),
) {}
