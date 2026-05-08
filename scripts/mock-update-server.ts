// @effect-diagnostics-next-line nodeBuiltinImport:off - NodeHttpServer.layer takes `NodeHttp.createServer` as arg
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

interface MockUpdateServerConfig {
  readonly port: number;
  readonly rootRealPath: string;
}

const resolveMockUpdateServerConfig = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Config.all({
    port: Config.port("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(Config.withDefault(3000)),
    root: Config.string("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_ROOT").pipe(
      Config.withDefault("../release-mock"),
    ),
  }).asEffect();

  const resolvedRoot = path.resolve(import.meta.dirname, config.root);

  return {
    port: config.port,
    rootRealPath: yield* fileSystem.realPath(resolvedRoot),
  } satisfies MockUpdateServerConfig;
});

const isOutsideRoot = (rootRealPath: string, filePath: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const relativePath = path.relative(rootRealPath, filePath);
    return (
      relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\")
    );
  });

const isWithinRoot = (rootRealPath: string, filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const resolvedFilePath = yield* fileSystem.realPath(filePath).pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (resolvedPath) => resolvedPath,
      }),
    );

    return (
      resolvedFilePath !== undefined && !(yield* isOutsideRoot(rootRealPath, resolvedFilePath))
    );
  });

const resolveRequestedFilePath = (rootRealPath: string, requestUrl: string | undefined) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const rawPath = (requestUrl ?? "/").split("?", 1)[0] ?? "/";
    const decodedPath = yield* Effect.try({
      try: () => decodeURIComponent(rawPath),
      catch: () => null,
    }).pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (value) => value,
      }),
    );

    if (!decodedPath) {
      return undefined;
    }

    if (decodedPath.includes("\0")) {
      return undefined;
    }

    const filePath = path.resolve(
      rootRealPath,
      `.${decodedPath.startsWith("/") ? decodedPath : `/${decodedPath}`}`,
    );

    return (yield* isOutsideRoot(rootRealPath, filePath)) ? undefined : filePath;
  });

const isServableFile = (rootRealPath: string, filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stat = yield* fileSystem.stat(filePath).pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (info) => info,
      }),
    );

    if (stat?.type !== "File") {
      return false;
    }

    return yield* isWithinRoot(rootRealPath, filePath);
  });

export const makeMockUpdateRouteLayer = (rootRealPath: string) => {
  return HttpRouter.add(
    "*",
    "*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const requestPath = (request.url ?? "/").split("?", 1)[0] ?? "/";
      yield* Effect.logInfo(`Request received for path: ${requestPath}`);

      const filePath = yield* resolveRequestedFilePath(rootRealPath, request.url);
      if (!filePath) {
        yield* Effect.logWarning(`Attempted to access file outside of root: ${request.url ?? "/"}`);
        return HttpServerResponse.text("Not Found", { status: 404 });
      }

      if (!(yield* isServableFile(rootRealPath, filePath))) {
        yield* Effect.logWarning(`Attempted to access invalid file: ${filePath}`);
        return HttpServerResponse.text("Not Found", { status: 404 });
      }

      yield* Effect.logInfo(`Serving file: ${filePath}`);
      return yield* HttpServerResponse.file(filePath, { status: 200 });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError(`Unhandled mock update request failure: ${cause}`);
          return HttpServerResponse.text("Internal Server Error", { status: 500 });
        }),
      ),
    ),
  );
};

const makeMockUpdateServerLayer = (config: MockUpdateServerConfig) =>
  HttpRouter.serve(makeMockUpdateRouteLayer(config.rootRealPath)).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(NodeHttp.createServer, {
        host: "localhost",
        port: config.port,
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

if (import.meta.main) {
  resolveMockUpdateServerConfig.pipe(
    Effect.map(makeMockUpdateServerLayer),
    Layer.unwrap,
    Layer.launch,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
