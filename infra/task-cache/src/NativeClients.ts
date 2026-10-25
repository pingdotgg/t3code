import type * as Cloudflare from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { developerIdentity } from "./developerAuth.ts";

export const routePrefix = "/projects/t3code/native-clients/";

export class NativeClientsError extends Schema.TaggedError<NativeClientsError>()(
  "NativeClientsError",
  { status: Schema.Number, reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export class Bindings extends Context.Service<
  Bindings,
  {
    readonly CLIENTS: Cloudflare.R2Bucket;
    readonly developerKeys: string;
    readonly readerKeys: string;
    readonly readLimit: Cloudflare.RateLimit;
    readonly storeLimit: Cloudflare.RateLimit;
  }
>()("@t3tools/task-cache/NativeClients/Bindings") {}

export class NativeClients extends Context.Service<
  NativeClients,
  { readonly handle: (request: Request) => Effect.Effect<Response> }
>()("@t3tools/task-cache/NativeClients") {}

const CompleteBody = Schema.fromJsonString(
  Schema.Struct({
    parts: Schema.Array(Schema.Struct({ partNumber: Schema.Number, etag: Schema.String })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(64),
    ),
  }),
);
const decodeComplete = Schema.decodeUnknownEffect(CompleteBody);

// <platform>/<variant>/<fingerprint>[/uploads[/<uploadId>[/<part>|/complete]]]
const route =
  /^((?:ios|android)\/[a-z0-9_-]{1,32}\/[a-f0-9]{40,64})(?:\/uploads(?:\/([^/]{1,1024})(?:\/(complete|[1-9][0-9]?))?)?)?$/;
const digestPattern = /^[a-f0-9]{64}$/;

const make = Effect.gen(function* () {
  const bindings = yield* Bindings;

  const r2 = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new NativeClientsError({ status: 503, reason: "storage_unavailable", cause }),
    });

  const limit = Effect.fn("NativeClients.limit")(function* (writing: boolean) {
    const allowed = yield* r2(() =>
      (writing ? bindings.storeLimit : bindings.readLimit).limit({
        key: writing ? "t3code:native-store" : "t3code:native-read",
      }),
    );
    if (!allowed.success)
      return yield* new NativeClientsError({ status: 429, reason: "rate_limit" });
  });

  const handle = Effect.fn("NativeClients.handle")(
    function* (request: Request) {
      const url = new URL(request.url);
      const match = route.exec(url.pathname.slice(routePrefix.length));
      if (!match || url.search || !url.pathname.startsWith(routePrefix))
        return yield* new NativeClientsError({ status: 404, reason: "unknown_route" });
      const [, key, uploadId, part] = match as unknown as [
        string,
        string,
        string | undefined,
        string | undefined,
      ];
      const operation =
        uploadId === undefined
          ? url.pathname.endsWith("/uploads")
            ? "create"
            : "download"
          : part === undefined
            ? "abort"
            : part === "complete"
              ? "complete"
              : "part";
      const method = {
        download: "GET",
        create: "POST",
        part: "PUT",
        complete: "POST",
        abort: "DELETE",
      }[operation];
      yield* Effect.annotateCurrentSpan({ "native.operation": operation, "native.key": key });
      if (request.method !== method)
        return yield* new NativeClientsError({ status: 405, reason: "method_not_allowed" });
      if (!request.headers.has("authorization"))
        return yield* new NativeClientsError({ status: 401, reason: "missing_identity" });

      const developer = yield* developerIdentity(request, bindings.developerKeys);
      const writing = operation !== "download";
      if (writing) {
        if (typeof developer !== "string")
          return yield* new NativeClientsError({ status: 403, reason: "write_denied" });
      } else if (
        typeof developer !== "string" &&
        typeof (yield* developerIdentity(request, bindings.readerKeys)) !== "string"
      ) {
        return yield* new NativeClientsError({ status: 403, reason: "read_denied" });
      }
      yield* limit(writing);

      if (operation === "download") {
        const object = yield* r2(() => bindings.CLIENTS.get(key));
        yield* Effect.annotateCurrentSpan({ "native.result": object ? "hit" : "miss" });
        if (!object) return yield* new NativeClientsError({ status: 404, reason: "missing" });
        return new Response(object.body as unknown as ReadableStream, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(object.size),
            "Cache-Control": "no-store",
            "X-T3-Digest": object.customMetadata?.digest ?? "",
            "X-T3-Build-Ms": object.customMetadata?.buildMs ?? "0",
          },
        });
      }
      if (operation === "create") {
        const digest = request.headers.get("x-t3-digest") ?? "";
        if (!digestPattern.test(digest))
          return yield* new NativeClientsError({ status: 400, reason: "invalid_digest" });
        if (yield* r2(() => bindings.CLIENTS.head(key))) {
          yield* Effect.annotateCurrentSpan({ "native.result": "exists" });
          return Response.json({ exists: true });
        }
        const buildMs = request.headers.get("x-t3-build-ms") ?? "";
        const upload = yield* r2(() =>
          bindings.CLIENTS.createMultipartUpload(key, {
            customMetadata: {
              digest,
              writer: developer!,
              buildMs: /^\d{1,10}$/.test(buildMs) ? buildMs : "0",
            },
          }),
        );
        return Response.json({ uploadId: upload.uploadId });
      }

      const decodedId = yield* Effect.try({
        try: () => decodeURIComponent(uploadId!),
        catch: () => new NativeClientsError({ status: 400, reason: "invalid_upload_id" }),
      });
      const upload = bindings.CLIENTS.resumeMultipartUpload(key, decodedId);
      if (operation === "abort") {
        yield* r2(() => upload.abort());
        return new Response(null, { status: 204 });
      }
      if (operation === "part") {
        if (!request.body || !request.headers.has("content-length"))
          return yield* new NativeClientsError({ status: 411, reason: "length_required" });
        const uploaded = yield* r2(() =>
          upload.uploadPart(Number(part), request.body as unknown as Cloudflare.ReadableStream),
        );
        return Response.json({ etag: uploaded.etag });
      }
      // A missing length would let text() buffer an unbounded body.
      const length = request.headers.get("content-length");
      if (length === null || !(Number(length) <= 64 * 1024))
        return yield* new NativeClientsError({ status: 413, reason: "parts_too_large" });
      const body = yield* decodeComplete(yield* r2(() => request.text())).pipe(
        Effect.mapError(() => new NativeClientsError({ status: 400, reason: "invalid_parts" })),
      );
      yield* r2(() => upload.complete([...body.parts]));
      yield* Effect.annotateCurrentSpan({ "native.result": "stored" });
      return new Response(null, { status: 204 });
    },
    Effect.catchTags({
      NativeClientsError: (error) =>
        Effect.gen(function* () {
          if (error.status >= 500)
            yield* Effect.logWarning("Native client request failed", { reason: error.reason });
          return Response.json({ error: error.reason }, { status: error.status });
        }),
    }),
  );

  return NativeClients.of({ handle });
});

export const layer = Layer.effect(NativeClients, make);
