// @effect-diagnostics nodeBuiltinImport:off - literal IPs bypass the HTTP agent's DNS lookup.
import * as NodeNet from "node:net";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import { GENERIC_MIME_TYPES } from "@t3tools/shared/image";

import { publicAddresses } from "../htmlRender/publicProxy.ts";
import { fileHeaderMimeType } from "../workspace/fileHeaderMimeType.ts";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export class RemoteImageError extends Schema.TaggedError<RemoteImageError>()("RemoteImageError", {
  reason: Schema.Literals([
    "invalid-url",
    "request",
    "redirects",
    "status",
    "not-image",
    "too-large",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return "The remote image could not be read.";
  }
}

export class RemoteImage extends Context.Service<
  RemoteImage,
  {
    readonly read: (url: string) => Effect.Effect<
      {
        readonly bytes: Uint8Array;
        readonly mimeType: string;
      },
      RemoteImageError
    >;
  }
>()("t3/assets/RemoteImage") {}

const make = Effect.gen(function* () {
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const read = Effect.fn("RemoteImage.read")(
    function* (source: string) {
      let target = source;
      for (let hop = 0; ; hop++) {
        const url = yield* Effect.try({
          try: () => new URL(target),
          catch: () => new RemoteImageError({ reason: "invalid-url" }),
        });
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
          return yield* new RemoteImageError({ reason: "invalid-url" });
        }
        const host = url.hostname.replace(/^\[|\]$/g, "");
        if (NodeNet.isIP(host) && !(yield* Effect.promise(() => publicAddresses(host)))) {
          return yield* new RemoteImageError({ reason: "invalid-url" });
        }
        const response = yield* http
          .execute(
            HttpClientRequest.get(url.href).pipe(
              HttpClientRequest.setHeader("accept-encoding", "identity"),
            ),
          )
          .pipe(Effect.mapError((cause) => new RemoteImageError({ reason: "request", cause })));
        if (response.status >= 300 && response.status < 400) {
          if (!response.headers.location || hop >= MAX_REDIRECTS) {
            return yield* new RemoteImageError({ reason: "redirects" });
          }
          target = yield* Effect.try({
            try: () => new URL(response.headers.location!, url).href,
            catch: () => new RemoteImageError({ reason: "invalid-url" }),
          });
          continue;
        }
        if (response.status !== 200) return yield* new RemoteImageError({ reason: "status" });
        const declaredMimeType =
          response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        const genericMimeType = declaredMimeType === "" || GENERIC_MIME_TYPES.has(declaredMimeType);
        if (!genericMimeType && !/^image\/[\w!#$&^.+-]+$/.test(declaredMimeType)) {
          return yield* new RemoteImageError({ reason: "not-image" });
        }
        if (Number(response.headers["content-length"]) > MAX_IMAGE_BYTES) {
          return yield* new RemoteImageError({ reason: "too-large" });
        }
        let size = 0;
        const chunks = yield* response.stream.pipe(
          Stream.mapError((cause) => new RemoteImageError({ reason: "request", cause })),
          Stream.tap((chunk) => {
            size += chunk.byteLength;
            return size > MAX_IMAGE_BYTES
              ? Effect.fail(new RemoteImageError({ reason: "too-large" }))
              : Effect.void;
          }),
          Stream.runCollect,
        );
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        // GitHub release downloads use octet-stream even for embedded screenshots.
        const mimeType = genericMimeType
          ? fileHeaderMimeType(bytes.subarray(0, 32))
          : declaredMimeType;
        if (!mimeType?.startsWith("image/")) {
          return yield* new RemoteImageError({ reason: "not-image" });
        }
        return { bytes, mimeType };
      }
    },
    Effect.scoped,
    Effect.timeout("15 seconds"),
    Effect.mapError((cause) =>
      cause._tag === "RemoteImageError"
        ? cause
        : new RemoteImageError({ reason: "request", cause }),
    ),
  );
  return RemoteImage.of({ read });
});

export const layer = Layer.effect(RemoteImage, make);

// Pin checked DNS results to the actual connection, including every redirect.
export const layerPublic = layer.pipe(
  Layer.provide(
    NodeHttpClient.layerNodeHttpOptions({
      lookup: (host, options, callback) => {
        void publicAddresses(host).then(
          (addresses) => {
            if (!addresses)
              return callback(new Error("Remote images require a public address"), []);
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          },
          (cause: Error) => callback(cause, []),
        );
      },
    }),
  ),
);
