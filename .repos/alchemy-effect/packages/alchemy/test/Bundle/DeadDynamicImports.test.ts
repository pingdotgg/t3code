import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Bundle from "@/Bundle/Bundle";

const HEAVY = "HEAVY_DEPLOY_TOOLING_MARKER";

/**
 * A temporary package whose `entry.ts` is `source`, next to a `heavy.ts`
 * standing in for deploy-time tooling (rolldown, Vite, …).
 */
const makeProject = (source: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-dead-dynamic-" });
    const entry = path.join(root, "entry.ts");
    yield* fs.writeFileString(entry, source);
    yield* fs.writeFileString(
      path.join(root, "heavy.ts"),
      `export const heavy = ${JSON.stringify(HEAVY)};\n`,
    );
    return { root, entry };
  });

const contents = (output: Bundle.BundleOutput) =>
  output.files.map((file) =>
    typeof file.content === "string" ? file.content : new TextDecoder().decode(file.content),
  );

layer(NodeServices.layer)("Bundle dead dynamic imports", (it) => {
  it.effect(
    "drops the chunk of a dynamic import that constant inlining made dead",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // The import only dies once `isRuntime` is inlined from another module,
        // after rolldown has already split `heavy.ts` into its own chunk.
        const { root, entry } = yield* makeProject(
          `import { load } from "./lib.ts";\nconsole.log(load());\n`,
        );
        yield* fs.writeFileString(path.join(root, "flag.ts"), `export const isRuntime = true;\n`);
        yield* fs.writeFileString(
          path.join(root, "lib.ts"),
          `import { isRuntime } from "./flag.ts";\n` +
            `export const load = () => (isRuntime ? undefined : import("./heavy.ts"));\n`,
        );
        const output = yield* Bundle.build({ input: entry, cwd: root });
        expect(output.files.map((file) => file.path)).toEqual(["entry.js"]);
        expect(contents(output).some((code) => code.includes(HEAVY))).toBe(false);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "keeps the chunk of a reachable dynamic import",
    () =>
      Effect.gen(function* () {
        const { root, entry } = yield* makeProject(
          `export const load = () => import("./heavy.ts");\n`,
        );
        const output = yield* Bundle.build({ input: entry, cwd: root });
        expect(contents(output).some((code) => code.includes(HEAVY))).toBe(true);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "drops chunks a dead lazy-import cycle keeps alive",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Vite's shape: the tool sets up lazy imports of its parts with
        // module-level calls, and the parts share a module that imports the
        // tool back, so rolldown keeps the parts alive although the only path
        // to the tool is deploy-time code that tree-shaking removes.
        const { root, entry } = yield* makeProject(
          `import { deploy } from "./deploy.ts";\n` +
            `export const runtime = globalThis.__ALCHEMY_RUNTIME__ ? "runtime" : deploy();\n`,
        );
        const files: Record<string, string> = {
          "deploy.ts": `export const deploy = () => import("./tool.ts");\n`,
          "tool.ts":
            `export const lazy = (load: () => unknown) => load;\n` +
            `lazy(() => import("./part-a.ts"));\n` +
            `lazy(() => import("./part-b.ts"));\n`,
          "shared.ts":
            `import { lazy } from "./tool.ts";\n` +
            `export const shared = lazy(() => ${JSON.stringify(HEAVY)});\n`,
          "part-a.ts": `import { shared } from "./shared.ts";\nexport default shared;\n`,
          "part-b.ts": `import { shared } from "./shared.ts";\nexport default shared;\n`,
        };
        for (const [name, source] of Object.entries(files)) {
          yield* fs.writeFileString(path.join(root, name), source);
        }
        for (const codeSplitting of [true, false]) {
          const output = yield* Bundle.build({ input: entry, cwd: root }, { codeSplitting });
          expect(output.files.map((file) => file.path)).toEqual(["entry.js"]);
          expect(contents(output).some((code) => code.includes(HEAVY))).toBe(false);
        }
      }),
    { tags: ["unit", "local"] },
  );
});
