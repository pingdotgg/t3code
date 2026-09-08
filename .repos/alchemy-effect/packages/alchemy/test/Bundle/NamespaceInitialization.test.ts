import * as Bundle from "@/Bundle/Bundle";
import type { FunctionZipProps } from "@/AWS/Lambda/Function";
import { makeFunctionBundler } from "@/AWS/Lambda/FunctionBundle";
import { exec } from "@/Util/exec.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";

/**
 * The side-effect-free Cloudflare barrel exposes Flagship through a nested
 * namespace. Its Providers graph imports Flagship's AppProvider while App
 * initializes `App = Resource(TypeId)`.
 */
layer(NodeServices.layer)("Bundle namespace initialization", (it) => {
  it.effect(
    "initializes Flagship App before the Cloudflare namespace consumes it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = process.cwd();
        const root = yield* fs.makeTempDirectory({
          directory: path.join(cwd, ".alchemy"),
          prefix: "namespace-initialization-",
        });

        try {
          const cloudflare = path.join(cwd, "src", "Cloudflare", "index.ts");
          const effect = path.join(
            cwd,
            "node_modules",
            "effect",
            "dist",
            "Effect.js",
          );
          const cause = path.join(
            cwd,
            "node_modules",
            "effect",
            "dist",
            "Cause.js",
          );
          const entry = path.join(root, "entry.ts");
          yield* fs.writeFileString(
            entry,
            [
              `import * as Cloudflare from ${JSON.stringify(cloudflare)};`,
              `import * as Effect from ${JSON.stringify(effect)};`,
              `import * as Cause from ${JSON.stringify(cause)};`,
              `const program = Effect.gen(function* () {`,
              `  return yield* Cloudflare.Flagship.App("Flags", {});`,
              `}).pipe(Effect.catchCause((cause) => Effect.sync(() => {`,
              `  const rendered = Cause.pretty(cause);`,
              `  if (rendered.includes("is not iterable") || rendered.includes("not a function")) {`,
              `    throw new Error(rendered);`,
              `  }`,
              `})));`,
              `Effect.runSync(program);`,
              `console.log("NAMESPACE_INITIALIZATION_MARKER");`,
            ].join("\n"),
          );

          const bundler = yield* makeFunctionBundler;
          const plan = yield* bundler.resolveBundlePlan({
            main: entry,
            isExternal: true,
            build: { external: ["cloudflare:workers"] },
          } as FunctionZipProps);
          const bundle = yield* Bundle.build(
            plan.inputOptions,
            plan.outputOptions,
            plan.extra,
          );
          yield* Effect.forEach(bundle.files, (file) => {
            const output = path.join(root, file.path);
            return Effect.gen(function* () {
              yield* fs.makeDirectory(path.dirname(output), {
                recursive: true,
              });
              if (typeof file.content === "string") {
                yield* fs.writeFileString(output, file.content);
              } else {
                yield* fs.writeFile(output, file.content);
              }
            });
          });
          const output = path.join(root, bundle.files[0].path);
          const result = yield* exec(
            ChildProcess.make(process.execPath, [output], { shell: false }),
          ).pipe(Effect.scoped);

          expect(result.stderr).toBe("");
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("NAMESPACE_INITIALIZATION_MARKER");
        } finally {
          yield* fs.remove(root, { recursive: true }).pipe(Effect.ignore);
        }
      }),
  );
});
