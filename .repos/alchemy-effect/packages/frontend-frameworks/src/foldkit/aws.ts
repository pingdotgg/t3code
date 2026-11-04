import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { runBuildChild } from "../core/BuildChild.ts";
import {
  DeployTargetError,
  makeDeployTarget,
  readServerModulesFromDisk,
  sortServerModules,
} from "../core/index.ts";
import { make, type FoldkitTarget, type FoldkitTargetConfig } from "./Foldkit.ts";

export interface FoldkitAwsTargetConfig extends FoldkitTargetConfig {
  /** Stream Lambda responses. @default true */
  readonly streaming?: boolean | undefined;
}
const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "aws", message, cause });

/** Use the same web Request/Response adapter as the other Lambda framework targets. */
const makeAwsFinishTarget = (config: FoldkitAwsTargetConfig = {}): FoldkitTarget =>
  makeDeployTarget({
    platform: "aws",
    config,
    bundle: {
      conditions: ["node", "import", "module"],
      external: ["@aws-sdk/"],
    },
    finish: (output, context) =>
      Effect.gen(function* () {
        if (!context.entry) return output;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        if (!output.distDirectory) return yield* fail("Foldkit produced no deployment directory.");
        const server = path.join(output.distDirectory, "server");
        const adapter = yield* Effect.try({
          try: () =>
            fileURLToPath(import.meta.resolve("@alchemy.run/frontend-frameworks/aws-lambda")),
          catch: (cause) => fail("Failed to resolve the Lambda adapter", cause),
        });
        const source = yield* fs.readFileString(adapter);
        yield* fs.writeFileString(
          path.join(server, "foldkit-aws-lambda.mjs"),
          source.replace(/^\/\/# sourceMappingURL=.*$/m, ""),
        );
        yield* fs.writeFileString(path.join(server, "package.json"), '{"type":"module"}\n');
        const wrap = config.streaming === false ? "toBufferedLambdaHandler" : "toLambdaHandler";
        yield* fs.writeFileString(
          path.join(server, "index.mjs"),
          `import entry from ${JSON.stringify("./" + path.relative(server, context.entry).replaceAll("\\", "/"))};
import { ${wrap} } from "./foldkit-aws-lambda.mjs";
export const handler = ${wrap}((request) => entry.fetch(request));
`,
        );
        const modules = yield* readServerModulesFromDisk({
          directory: server,
          prefix: "server",
        }).pipe(Effect.mapError((error) => fail(error.message, error.cause)));
        return {
          ...output,
          serverModules: sortServerModules(modules, "server/index.mjs"),
        };
      }).pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(fail("Failed to emit the Foldkit Lambda entry", cause)),
        ),
      ),
  });

export const buildInChild = (input: {
  readonly rootDir: string;
  readonly config: FoldkitAwsTargetConfig;
}) =>
  Effect.gen(function* () {
    const framework = yield* make({
      ...input.config,
      root: input.rootDir,
      target: makeAwsFinishTarget(input.config),
    });
    return yield* framework.build({ root: input.rootDir });
  });
export const makeAwsTarget = (config: FoldkitAwsTargetConfig = {}): FoldkitTarget => ({
  ...makeAwsFinishTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "foldkit",
      config: { rootDir: context.root, config },
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});
export const target = makeAwsTarget;
export default makeAwsTarget;
