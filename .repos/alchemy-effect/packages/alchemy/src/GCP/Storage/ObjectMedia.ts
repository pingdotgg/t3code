import { Credentials } from "@distilled.cloud/gcp/Credentials";
import type * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

/**
 * Object content transfer over the Cloud Storage JSON API media endpoints
 * (`alt=media` download, `uploadType=multipart` upload). The generated
 * storage SDK only covers the metadata surface — `objects.get` returns
 * metadata and `objects.insert` without the `/upload` path is rejected —
 * so content bindings speak these two endpoints directly.
 *
 * NOT exported from `index.ts`.
 */

const API = "https://storage.googleapis.com";

/** The object (or bucket) does not exist. */
export class ObjectNotFound extends Data.TaggedError(
  "GCP.Storage.ObjectNotFound",
)<{
  bucket: string;
  object: string;
}> {}

/** Cloud Storage rejected the request. */
export class ObjectRequestFailed extends Data.TaggedError(
  "GCP.Storage.ObjectRequestFailed",
)<{
  bucket: string;
  object: string;
  status: number;
  message: string;
}> {}

export interface ObjectContent {
  /** Raw object bytes. */
  body: Uint8Array;
  /** `Content-Type` the object was stored with. */
  contentType: string | undefined;
  /** Object generation served. */
  generation: string | undefined;
}

export interface PutObjectContent {
  /** Object name (key). */
  name: string;
  /** Object content. Strings are encoded as UTF-8. */
  body: string | Uint8Array;
  /** @default "application/octet-stream" (or "text/plain; charset=utf-8" for strings) */
  contentType?: string;
  /** Custom metadata stored on the object. */
  metadata?: Record<string, string>;
  /** `Cache-Control` served with the object. */
  cacheControl?: string;
  /** Only write when the live generation matches (`0` = only if absent). */
  ifGenerationMatch?: string;
}

const isRetryable = (error: ObjectNotFound | ObjectRequestFailed) =>
  error._tag === "GCP.Storage.ObjectRequestFailed" &&
  (error.status === 429 || error.status >= 500);

const failureOf = (
  bucket: string,
  object: string,
  response: HttpClientResponse.HttpClientResponse,
) =>
  Effect.gen(function* () {
    if (response.status === 404) {
      return yield* new ObjectNotFound({ bucket, object });
    }
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* new ObjectRequestFailed({
      bucket,
      object,
      status: response.status,
      message: text.slice(0, 500),
    });
  });

const transportFailure =
  (bucket: string, object: string) => (cause: { message?: string }) =>
    new ObjectRequestFailed({
      bucket,
      object,
      status: 0,
      message: cause.message ?? String(cause),
    });

/**
 * Build the download / upload callables once, closing over the ambient
 * `Credentials` and `HttpClient` (resolved at Layer construction, like a
 * distilled operation).
 */
export const makeObjectMedia = Effect.gen(function* () {
  const credentials = yield* Credentials;
  const http = yield* HttpClient.HttpClient;

  const authorized = (request: HttpClientRequest.HttpClientRequest) =>
    credentials.pipe(
      Effect.map((config) =>
        request.pipe(HttpClientRequest.bearerToken(config.accessToken)),
      ),
    );

  const download = (options: {
    bucket: string;
    object: string;
    generation?: string;
  }) =>
    Effect.gen(function* () {
      const request = yield* authorized(
        HttpClientRequest.get(
          `${API}/storage/v1/b/${encodeURIComponent(options.bucket)}/o/${encodeURIComponent(options.object)}`,
        ).pipe(
          HttpClientRequest.setUrlParams({
            alt: "media",
            ...(options.generation === undefined
              ? {}
              : { generation: options.generation }),
          }),
        ),
      );
      const response = yield* http
        .execute(request)
        .pipe(
          Effect.mapError(transportFailure(options.bucket, options.object)),
        );
      if (response.status !== 200) {
        return yield* failureOf(options.bucket, options.object, response);
      }
      const body = yield* response.arrayBuffer.pipe(
        Effect.mapError(transportFailure(options.bucket, options.object)),
      );
      return {
        body: new Uint8Array(body),
        contentType: response.headers["content-type"],
        generation: response.headers["x-goog-generation"],
      } satisfies ObjectContent;
    }).pipe(
      Effect.retry({
        while: isRetryable,
        times: 4,
        schedule: Schedule.exponential("200 millis"),
      }),
    );

  const upload = (bucket: string, options: PutObjectContent) =>
    Effect.gen(function* () {
      const bytes =
        typeof options.body === "string"
          ? new TextEncoder().encode(options.body)
          : options.body;
      const contentType =
        options.contentType ??
        (typeof options.body === "string"
          ? "text/plain; charset=utf-8"
          : "application/octet-stream");
      const boundary = yield* Effect.sync(
        () => `alchemy-${crypto.randomUUID()}`,
      );
      const metadata = JSON.stringify({
        name: options.name,
        contentType,
        metadata: options.metadata,
        cacheControl: options.cacheControl,
      });
      const encoder = new TextEncoder();
      const head = encoder.encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
          `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
      );
      const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
      const payload = new Uint8Array(head.length + bytes.length + tail.length);
      payload.set(head, 0);
      payload.set(bytes, head.length);
      payload.set(tail, head.length + bytes.length);

      const request = yield* authorized(
        HttpClientRequest.post(
          `${API}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`,
        ).pipe(
          HttpClientRequest.setUrlParams({
            uploadType: "multipart",
            ...(options.ifGenerationMatch === undefined
              ? {}
              : { ifGenerationMatch: options.ifGenerationMatch }),
          }),
          HttpClientRequest.bodyUint8Array(
            payload,
            `multipart/related; boundary=${boundary}`,
          ),
        ),
      );
      const response = yield* http
        .execute(request)
        .pipe(Effect.mapError(transportFailure(bucket, options.name)));
      if (response.status !== 200) {
        return yield* failureOf(bucket, options.name, response);
      }
      const json = yield* response.json.pipe(
        Effect.mapError(transportFailure(bucket, options.name)),
      );
      // The upload endpoint answers with the same `Object` resource
      // `objects.insert` documents.
      return json as storage.Storage_Object;
    }).pipe(
      Effect.retry({
        while: isRetryable,
        times: 4,
        schedule: Schedule.exponential("200 millis"),
      }),
    );

  return { download, upload };
});
