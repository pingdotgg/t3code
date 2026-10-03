/**
 * The `HttpPlatform`, `Etag`, `Path`, and no-op `FileSystem` services `HttpApiBuilder.layer`
 * wants, for runtimes without a filesystem: Workers, Lambda. File responses
 * die, compression never engages.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";

const HttpPlatformStub: Layer.Layer<HttpPlatform.HttpPlatform> = Layer.succeed(
  HttpPlatform.HttpPlatform,
  {
    platform: "web",
    // Advertises no algorithms, so the compression middleware never engages
    // and compressResponse is never called.
    compression: {
      algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
      compressResponse: (response) => Effect.succeed(response),
    },
    fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
    fileWebResponse: () =>
      Effect.die("HttpPlatform.fileWebResponse not supported"),
  },
);

/**
 * Provide it to `HttpApiBuilder.layer(api)` in a Worker or a Lambda:
 *
 * ```typescript
 * HttpApiBuilder.layer(Api).pipe(
 *   Layer.provide(handlers),
 *   Layer.provide(Http.Platform),
 *   HttpRouter.toHttpEffect,
 * )
 * ```
 */
export const Platform: Layer.Layer<
  Etag.Generator | HttpPlatform.HttpPlatform | Path.Path | FileSystem.FileSystem
> = Layer.mergeAll(
  Etag.layer,
  HttpPlatformStub,
  Path.layer,
  FileSystem.layerNoop({}),
);
