import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { Self } from "../../Self.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import type { PermissionGroupRef } from "../ApiToken/Common.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import type { Bucket } from "./Bucket.ts";
import { R2Error, type R2Object } from "./BucketTypes.ts";

/**
 * Injectable auth used by the R2 HTTP client builders. Both the token-scoped
 * `*Http` layers and the current-credentials `*Local` layers build one of
 * these so they can share the exact same client implementation.
 */
export interface R2Auth {
  /** Provide credentials + HTTP client to a raw distilled R2 op. */
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, RuntimeContext>;
  /** Resolve the Cloudflare account id. */
  accountId: Effect.Effect<string>;
}

export const makeHttpBucketBinding = <Client>(options: {
  permissionGroups: PermissionGroup[];
  makeClient: (
    token: HttpToken,
    bucketName: Effect.Effect<string>,
    jurisdiction: Effect.Effect<string>,
  ) => Client;
}) =>
  Effect.gen(function* () {
    const Token = yield* AccountApiToken;
    const self = yield* Self;
    const env = yield* CloudflareEnvironment;

    return Effect.fn(function* (bucket: Bucket) {
      const { accountId } = yield* env;
      const token = yield* Token(`${self.LogicalId}Token`);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* token.bind`${bucket.LogicalId}`({
          policies: [
            {
              effect: "allow",
              permissionGroups: options.permissionGroups,
              resources: {
                [`com.cloudflare.api.account.${accountId}`]: "*",
              },
            },
          ],
        });
      }
      const bound = {
        value: yield* token.value,
        accountId: yield* token.accountId,
      } satisfies HttpToken;
      const bucketName = yield* bucket.bucketName;
      const jurisdiction = yield* bucket.jurisdiction;
      return options.makeClient(bound, bucketName, jurisdiction);
    });
  });

export interface HttpScope {
  accountId: string;
  bucketName: string;
  cfR2Jurisdiction: string | undefined;
}
export interface HttpToken {
  value: Effect.Effect<Redacted.Redacted<string>>;
  accountId: Effect.Effect<string>;
}

const R2_HTTP_PERMISSION_GROUPS: PermissionGroupRef[] = [
  "Workers R2 Storage Read",
  "Workers R2 Storage Write",
];

type PermissionGroup = (typeof R2_HTTP_PERMISSION_GROUPS)[number];

/** Resolve the account, bucket, and jurisdiction once per operation. */
export const makeR2HttpScope = (
  accountId: Effect.Effect<string>,
  bucketName: Effect.Effect<string>,
  jurisdiction: Effect.Effect<string>,
): Effect.Effect<HttpScope> =>
  Effect.gen(function* () {
    const accountId_ = yield* accountId;
    const bucket = yield* bucketName;
    const j = yield* jurisdiction;
    return {
      accountId: accountId_,
      bucketName: bucket,
      cfR2Jurisdiction: j === "default" ? undefined : j,
    };
  });

/**
 * Bind the token's `value` (as `secret_text`) and `accountId` (as `plain_text`)
 * into the Worker so they can be read at runtime.
 */

export const toR2Error = (error: unknown): R2Error =>
  new R2Error({
    message:
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : "Unknown R2 error",
    cause: error instanceof Error ? error : new Error(String(error)),
  });

const stripQuotes = (etag: string | undefined): string | undefined =>
  etag === undefined ? undefined : etag.replace(/^"|"$/g, "");

export interface HttpMetadata {
  contentType?: string;
  contentEncoding?: string;
  contentDisposition?: string;
  contentLanguage?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

/** Normalize the caller's `httpMetadata` option (object or `Headers`). */
export const readHttpMetadata = (
  options: { httpMetadata?: unknown } | undefined,
): HttpMetadata | undefined => {
  const meta = options?.httpMetadata;
  if (!meta) return undefined;
  if (meta instanceof Headers) {
    return {
      contentType: meta.get("content-type") ?? undefined,
      contentEncoding: meta.get("content-encoding") ?? undefined,
      contentDisposition: meta.get("content-disposition") ?? undefined,
      contentLanguage: meta.get("content-language") ?? undefined,
      cacheControl: meta.get("cache-control") ?? undefined,
    };
  }
  return meta as HttpMetadata;
};

/** Write an object's HTTP metadata onto a `Headers` instance. */
const applyHttpMetadata = (headers: Headers, meta: HttpMetadata): void => {
  if (meta.contentType) headers.set("content-type", meta.contentType);
  if (meta.contentEncoding)
    headers.set("content-encoding", meta.contentEncoding);
  if (meta.contentDisposition)
    headers.set("content-disposition", meta.contentDisposition);
  if (meta.contentLanguage)
    headers.set("content-language", meta.contentLanguage);
  if (meta.cacheControl) headers.set("cache-control", meta.cacheControl);
};

export const baseObject = (
  key: string,
  meta: HttpMetadata,
  attrs: {
    size?: number;
    etag?: string;
    uploaded?: Date;
    storageClass?: string;
    customMetadata?: Record<string, string>;
  },
): R2Object =>
  ({
    key,
    version: "",
    size: attrs.size ?? 0,
    etag: stripQuotes(attrs.etag) ?? "",
    httpEtag: attrs.etag ?? "",
    checksums: {},
    uploaded: attrs.uploaded ?? new Date(0),
    httpMetadata: meta,
    customMetadata: attrs.customMetadata ?? {},
    range: undefined,
    storageClass: attrs.storageClass ?? "Standard",
    writeHttpMetadata: (headers: Headers) =>
      Effect.sync(() => applyHttpMetadata(headers, meta)),
  }) as unknown as R2Object;

/** Collect a put `value` into a body accepted by the R2 HTTP API. */
export const toBody = (
  value:
    | ReadableStream
    | ArrayBuffer
    | ArrayBufferView
    | string
    | null
    | Blob
    | Stream.Stream<Uint8Array, unknown>,
): Effect.Effect<
  { body: Blob | Uint8Array | ArrayBuffer | string; contentLength?: number },
  R2Error
> =>
  Effect.gen(function* () {
    if (value === null) return { body: new Uint8Array(0), contentLength: 0 };
    if (typeof value === "string") return { body: value };
    if (value instanceof Blob)
      return { body: value, contentLength: value.size };
    if (value instanceof ArrayBuffer)
      return { body: value, contentLength: value.byteLength };
    if (Stream.isStream(value) || value instanceof ReadableStream) {
      const readable = Stream.isStream(value)
        ? Stream.toReadableStream(value)
        : value;
      const buffer = yield* Effect.tryPromise({
        try: () => new Response(readable as any).arrayBuffer(),
        catch: toR2Error,
      });
      return { body: new Uint8Array(buffer), contentLength: buffer.byteLength };
    }
    const view = value as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return { body: bytes, contentLength: bytes.byteLength };
  });
