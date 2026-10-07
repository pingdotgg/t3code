import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  finishNeonOutput,
  makeNeonServeEntrySource,
  makeNeonTarget,
} from "../core/NeonServe.ts";
import { toOutputFile } from "../core/BuildOutput.ts";
import { DeployTargetError } from "../core/DeployTarget.ts";
import { pinNodeServeModule } from "../core/NodeServe.ts";
import type { FrameworkBuildOptions } from "../core/Framework.ts";
import {
  make as makeNode,
  makeNodeTarget,
  NEXT_PRODUCTION_APP_SOURCE,
  type NextjsNodeOptions,
} from "./node.ts";

/** Next.js production Node handler adapted to Neon's Fetch interface. */
export const target = (config?: Parameters<typeof makeNodeTarget>[0]) => {
  const node = makeNodeTarget(config);
  return {
    ...makeNeonTarget(node),
    build: (context: Parameters<NonNullable<typeof node.build>>[0]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const output = yield* node.build!(context).pipe(
          Effect.flatMap(finishNeonOutput),
        );
        const nodeServe = {
          ...output.nodeServe,
          handler: {
            kind: "fetch" as const,
            imports: [
              'import requestMeta from "next/dist/server/request-meta.js";',
              'import { toFetchHandler } from "./neon-node-adapter.mjs";',
              NEXT_PRODUCTION_APP_SOURCE,
              "const nextHandler = app.getRequestHandler();",
              "const fetchNext = request => {",
              "  const url = new URL(request.url);",
              "  return toFetchHandler((req, res) => {",
              "    const protocol = url.protocol.slice(0, -1);",
              "    req.headers.host = url.host;",
              '    req.headers["x-forwarded-host"] = url.host;',
              '    req.headers["x-forwarded-proto"] = protocol;',
              '    req.headers["x-forwarded-port"] = url.port || (protocol === "https" ? "443" : "80");',
              "    const meta = requestMeta.getRequestMeta(req);",
              "    // Fetch supplies the initial URL; Next's router and renderer must not replace it with a listening address.",
              "    Object.defineProperties(meta, {",
              "      initURL: { enumerable: true, get: () => request.url, set() {} },",
              "      initProtocol: { enumerable: true, get: () => protocol, set() {} },",
              "    });",
              "    requestMeta.setRequestMeta(req, meta);",
              "    Promise.resolve(nextHandler(req, res)).catch(error => res.destroy(error));",
              "  })(request);",
              "};",
            ].join("\n"),
            expr: "fetchNext",
          },
        };
        const name = output.serverModules![0]!.name;
        const source = makeNeonServeEntrySource(nodeServe);
        yield* fs.writeFileString(
          path.join(output.distDirectory!, name),
          source,
        );
        return pinNodeServeModule(
          { ...output, nodeServe },
          yield* toOutputFile(name, source),
        );
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof DeployTargetError
            ? cause
            : new DeployTargetError({
                platform: "neon",
                message: "Failed to emit the Next.js Fetch entry.",
                cause,
              }),
        ),
      ),
  };
};
export default target;

/** Native Next.js development with Neon-compatible production output. */
export const make = Effect.fn(function* (options: NextjsNodeOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const node = yield* makeNode(options);
  const services = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem)(fs),
    Layer.succeed(Path.Path)(path),
  );
  return {
    dev: node.dev,
    build: (buildOptions?: FrameworkBuildOptions) =>
      Effect.gen(function* () {
        const root = yield* Effect.sync(() =>
          path.resolve(buildOptions?.root ?? options.root ?? process.cwd()),
        );
        return yield* target({ root }).build!({
          root,
          framework: "nextjs",
          env: buildOptions?.env,
        });
      }).pipe(Effect.provide(services)),
  };
});
