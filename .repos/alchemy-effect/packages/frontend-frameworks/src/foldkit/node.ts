import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { runBuildChild } from "../core/BuildChild.ts";
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import {
  NODE_BUNDLE_CONDITIONS,
  NODE_SERVE_ENTRY_FILE_NAME,
  relativeClientDirExpression,
  writeNodeServeEntry,
} from "../core/NodeServe.ts";
import { make, type FoldkitTarget, type FoldkitTargetConfig } from "./Foldkit.ts";

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "node", message, cause });

const makeNodeFinishTarget = (config: FoldkitTargetConfig = {}): FoldkitTarget =>
  makeDeployTarget({
    platform: "node",
    config,
    bundle: { conditions: [...NODE_BUNDLE_CONDITIONS] },
    finish: (output, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        if (!output.distDirectory || !output.clientDirectory)
          return yield* fail("Foldkit produced no deployment or client directory.");
        const server = path.join(output.distDirectory, "server");
        yield* fs.makeDirectory(server, { recursive: true });
        yield* fs.writeFileString(path.join(server, "package.json"), '{"type":"module"}\n');
        const servePath = path.join(server, NODE_SERVE_ENTRY_FILE_NAME);
        const handler =
          context.entry === undefined
            ? undefined
            : {
                kind: "fetch" as const,
                imports: `import entry from ${JSON.stringify("./" + path.relative(server, context.entry).replaceAll("\\", "/"))};`,
                expr: "(request) => entry.fetch(request)",
              };
        return yield* writeNodeServeEntry({
          output,
          servePath,
          serveModuleName: `server/${NODE_SERVE_ENTRY_FILE_NAME}`,
          clientDirExpression: relativeClientDirExpression(servePath, output.clientDirectory),
          handler,
          assetBasePath: context.assetBasePath,
          serveRootIndex: true,
          notFoundHandling:
            config.notFoundHandling ?? (handler || config.output === "static" ? "none" : "spa"),
          htmlHandling: config.htmlHandling,
          platform: "node",
        });
      }).pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(fail("Failed to emit the Foldkit Node entry", cause)),
        ),
      ),
  });

/** Isolate Vite configuration execution from the deployment process. */
export const buildInChild = (input: {
  readonly rootDir: string;
  readonly config: FoldkitTargetConfig;
}) =>
  Effect.gen(function* () {
    const framework = yield* make({
      ...input.config,
      root: input.rootDir,
      target: makeNodeFinishTarget(input.config),
    });
    return yield* framework.build({ root: input.rootDir });
  });

export const makeNodeTarget = (config: FoldkitTargetConfig = {}): FoldkitTarget => ({
  ...makeNodeFinishTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "foldkit",
      config: { rootDir: context.root, config },
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});
export const target = makeNodeTarget;
export default makeNodeTarget;
