/**
 * Runtime half of the Prisma Object Store bindings: an S3-compatible client
 * pointed at a bucket key's endpoint. Internal — the capability modules
 * (`ReadBucket.ts`, `WriteBucket.ts`, `ReadWriteBucket.ts`) build their public
 * clients on top of these primitives.
 */
import { Credentials, Endpoint, Presign, Region } from "@distilled.cloud/aws";
import type * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import {
  BucketError,
  type BucketCredentials,
  type BucketObject,
  type BucketObjectBody,
  type BucketRange,
} from "../BucketTypes.ts";

/**
 * SigV4 credential scope used for Prisma Object Store requests. Prisma
 * addresses buckets through a single regionless endpoint and does not report
 * a region on a bucket key, so requests are signed under the `auto` scope
 * that S3-compatible stores conventionally accept.
 */
export const BUCKET_SIGNING_REGION = "auto";

export type PresignRequest =
  | {
      method: "GET";
      key: string;
      expiresIn?: number | undefined;
      /** Signed `response-content-type` override for the download. */
      responseContentType?: string | undefined;
    }
  | {
      method: "PUT";
      key: string;
      expiresIn?: number | undefined;
      /** `Content-Type` header the uploader must send, signed into the URL. */
      contentType?: string | undefined;
    };

/**
 * The transport a capability client is built against: the resolved bucket
 * name, a way to run a distilled S3 operation with the bucket key's
 * credentials, and SigV4 query-string presigning against the same endpoint.
 */
export interface BucketAccess {
  bucketName: Effect.Effect<string, never, RuntimeContext>;
  authorize: <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Credentials.Credentials | Region.Region | HttpClient
    >,
  ) => Effect.Effect<A, E, RuntimeContext>;
  presign: (
    request: PresignRequest,
  ) => Effect.Effect<string, BucketError, RuntimeContext>;
}

export const toBucketError = (error: unknown): BucketError =>
  new BucketError({
    message:
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : "Unknown Prisma Object Store error",
    cause: error instanceof Error ? error : new Error(String(error)),
  });

const signingContext = (credentials: BucketCredentials) =>
  Effect.all([
    credentials.endpoint,
    credentials.accessKeyId,
    credentials.secretAccessKey,
  ]).pipe(
    Effect.map(([endpoint, accessKeyId, secretAccessKey]) =>
      Layer.mergeAll(
        Layer.succeed(
          Credentials.Credentials,
          Effect.succeed({
            accessKeyId: Redacted.make(accessKeyId),
            secretAccessKey,
            sessionToken: undefined,
            region: BUCKET_SIGNING_REGION,
          }),
        ),
        Layer.succeed(Region.Region, Effect.succeed(BUCKET_SIGNING_REGION)),
        Layer.succeed(Endpoint.Endpoint, Effect.succeed(endpoint)),
        FetchHttpClient.layer,
      ),
    ),
  );

/**
 * Build the transport for a bound bucket key. Requests are signed with the
 * key's own credentials against its endpoint; because a custom endpoint is
 * set, the S3 client addresses the bucket path-style rather than through the
 * AWS virtual-host rules.
 */
export const makeBucketAccess = (
  credentials: BucketCredentials,
): BucketAccess => {
  const context = signingContext(credentials);
  return {
    bucketName: credentials.bucketName,
    authorize: (effect) =>
      context.pipe(Effect.flatMap((layer) => Effect.provide(effect, layer))),
    presign: (request) =>
      Effect.all([context, credentials.bucketName]).pipe(
        Effect.flatMap(([layer, bucket]) =>
          Presign.presignS3Url({
            method: request.method,
            bucket,
            key: request.key,
            region: BUCKET_SIGNING_REGION,
            expiresIn: request.expiresIn,
            contentType:
              request.method === "PUT" ? request.contentType : undefined,
            responseContentType:
              request.method === "GET"
                ? request.responseContentType
                : undefined,
          }).pipe(Effect.provide(layer)),
        ),
        Effect.mapError(toBucketError),
      ),
  };
};

/** Render a {@link BucketRange} as an HTTP `Range` header value. */
export const rangeHeader = (range: BucketRange | undefined) => {
  if (range === undefined) return undefined;
  const end =
    range.length === undefined ? "" : String(range.offset + range.length - 1);
  return `bytes=${range.offset}-${end}`;
};

const stripQuotes = (etag: string | undefined) =>
  etag === undefined ? "" : etag.replaceAll('"', "");

const definedMetadata = (
  metadata: { [key: string]: string | undefined } | undefined,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== undefined) result[key] = value;
  }
  return result;
};

export const objectFrom = (
  key: string,
  attributes: {
    ContentLength?: number | undefined;
    ETag?: string | undefined;
    LastModified?: Date | undefined;
    ContentType?: string | undefined;
    Metadata?: { [key: string]: string | undefined } | undefined;
  },
): BucketObject => ({
  key,
  size: attributes.ContentLength ?? 0,
  etag: stripQuotes(attributes.ETag),
  lastModified: attributes.LastModified,
  contentType: attributes.ContentType,
  metadata: definedMetadata(attributes.Metadata),
});

export const objectFromListEntry = (entry: S3.Object): BucketObject => ({
  key: entry.Key ?? "",
  size: entry.Size ?? 0,
  etag: stripQuotes(entry.ETag),
  lastModified: entry.LastModified,
  contentType: undefined,
  metadata: {},
});

const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

/**
 * Wrap a `GetObject` response as a {@link BucketObjectBody}. The body is a
 * single-consumption stream, so `body` and the buffering accessors are three
 * views of the same bytes and only one of them may be read.
 */
export const objectBodyFrom = (
  key: string,
  response: S3.GetObjectOutput,
): BucketObjectBody => {
  const body = (response.Body ?? Stream.empty).pipe(
    Stream.mapError(toBucketError),
  );
  const bytes = () => Stream.runCollect(body).pipe(Effect.map(concatBytes));
  const text = () => Stream.mkString(Stream.decodeText(body));
  return {
    ...objectFrom(key, response),
    body,
    bytes,
    arrayBuffer: () =>
      bytes().pipe(
        Effect.map((collected) => {
          const buffer = new ArrayBuffer(collected.byteLength);
          new Uint8Array(buffer).set(collected);
          return buffer;
        }),
      ),
    text,
    json: <T>() =>
      text().pipe(
        Effect.flatMap((decoded) =>
          Effect.try({
            try: () => JSON.parse(decoded) as T,
            catch: toBucketError,
          }),
        ),
      ),
  };
};
