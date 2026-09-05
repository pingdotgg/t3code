import * as kv from "@distilled.cloud/cloudflare/kv";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeHttpKVNamespaceBinding,
  makeKVAuth,
  makeKVHttpScope,
  toKVNamespaceError,
  type KVAuth,
} from "./NamespaceHttp.ts";
import { NamespaceError } from "./NamespaceTypes.ts";
import { WriteNamespace, type WriteNamespaceClient } from "./WriteNamespace.ts";

/**
 * HTTP-backed implementation of the {@link WriteNamespace} binding.
 *
 * It creates a scoped {@link AccountApiToken} with the `Workers KV Storage
 * Write` permission and writes values via the Cloudflare KV HTTP API.
 */
export const WriteNamespaceHttp = Layer.effect(
  WriteNamespace,
  Effect.suspend(() =>
    makeHttpKVNamespaceBinding({
      permissionGroups: ["Workers KV Storage Write"],
      makeClient: (token, namespaceId) =>
        makeWriteKVHttpClient(makeKVAuth(token), namespaceId),
    }),
  ),
);

export const makeWriteKVHttpClient = (
  auth: KVAuth,
  namespaceId: Effect.Effect<string>,
): WriteNamespaceClient => {
  const { authorize } = auth;
  const scope = makeKVHttpScope(auth, namespaceId);

  return {
    put: ((
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      options?: KVNamespacePutOptions,
    ) =>
      scope.pipe(
        Effect.flatMap(({ accountId, namespaceId }) =>
          toKVBody(value).pipe(
            Effect.flatMap((body) =>
              authorize(
                kv.putNamespaceValue({
                  accountId,
                  namespaceId,
                  keyName: key,
                  value: body,
                  expiration: options?.expiration,
                  expirationTtl: options?.expirationTtl,
                  metadata: options?.metadata,
                }),
              ),
            ),
          ),
        ),
        Effect.mapError(toKVNamespaceError),
        Effect.asVoid,
      )) as any,
    delete: ((key: string) =>
      scope.pipe(
        Effect.flatMap(({ accountId, namespaceId }) =>
          authorize(
            kv.deleteNamespaceValue({ accountId, namespaceId, keyName: key }),
          ),
        ),
        Effect.mapError(toKVNamespaceError),
        Effect.asVoid,
      )) as any,
  };
};

/** Collect a put value into a body accepted by the KV HTTP API. */
const toKVBody = (
  value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
): Effect.Effect<string | Blob, NamespaceError> =>
  Effect.gen(function* () {
    if (typeof value === "string") return value;
    if (value instanceof Blob) return value;
    if (value instanceof ArrayBuffer) return new Blob([value]);
    if (value instanceof ReadableStream) {
      const buffer = yield* Effect.tryPromise({
        try: () => new Response(value as any).arrayBuffer(),
        catch: toKVNamespaceError,
      });
      return new Blob([buffer]);
    }
    const view = value as ArrayBufferView;
    const bytes = new Uint8Array(view.byteLength);
    bytes.set(
      new Uint8Array(
        view.buffer as ArrayBuffer,
        view.byteOffset,
        view.byteLength,
      ),
    );
    return new Blob([bytes]);
  });
