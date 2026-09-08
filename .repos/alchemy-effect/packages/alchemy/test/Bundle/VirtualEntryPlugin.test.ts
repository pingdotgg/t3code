import * as Bundle from "@/Bundle/Bundle";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import {
  isolatedProject,
  materializeIsolatedProject,
  removeIsolatedProject,
} from "../IsolatedProject.ts";

/** Bare (non-relative, non-builtin) `import` statements left in the chunks. */
const bareImports = (result: Bundle.BundleOutput) =>
  result.files
    .filter((file) => typeof file.content === "string")
    .flatMap((file) => (file.content as string).split("\n"))
    .filter((line) => /^import\b/.test(line))
    .filter((line) => !/["'](\.\/|node:)/.test(line));

/** Every generated-entry bootstrap module (see src/Runtime/Bootstrap). */
const BOOTSTRAP_MODULES = [
  "Ecs",
  "AppRunner",
  "Batch",
  "Ec2",
  "Lambda",
  "MicrovmBun",
  "MicrovmNode",
  "CloudflareContainerBun",
  "CloudflareContainerNode",
  "Docker",
  "Fly",
  "Hetzner",
  "Prisma",
  "Railway",
] as const;

layer(NodeServices.layer)("generated entry bootstraps", (it) => {
  // The contract every platform's generated entry relies on: a consumer
  // project that has `alchemy` installed and NOTHING else reachable (bun's
  // isolated linker / pnpm) must be able to bundle
  // `alchemy/Runtime/Bootstrap/<Platform>` — i.e. alchemy's own dependencies
  // (`@distilled.cloud/*`, `@effect/platform-*`) resolve from alchemy's
  // location, never from the consumer's. Before the bootstraps became real
  // modules, the entry imported those directly and an isolated project left
  // them external (the deployed process died with `Cannot find module`).
  for (const name of BOOTSTRAP_MODULES) {
    it.effect(
      `alchemy/Runtime/Bootstrap/${name} bundles from an isolated project`,
      () =>
        Effect.gen(function* () {
          const project = isolatedProject(
            `bootstrap-${name.toLowerCase()}`,
            import.meta.filename,
          );
          yield* materializeIsolatedProject(project);
          const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
          // The exact production condition sets: bun modules resolve
          // `alchemy/*` through the `bun` condition (`src/*.ts`); node
          // modules (Lambda zip, the *Node container variants) resolve
          // through `import` → `lib/*.js`, so this test requires a built
          // lib (`pnpm build`), exactly like a deployed Node bundle.
          const isNode = name.endsWith("Node") || name === "Lambda";

          try {
            const result = yield* Bundle.build(
              {
                cwd: project.dir,
                input: project.main,
                platform: "node",
                external: ["bun", "bun:*"],
                resolve: {
                  conditionNames: isNode
                    ? [...Bundle.NODE_CONDITION_NAMES]
                    : [...Bundle.BUN_CONDITION_NAMES],
                },
                plugins: [
                  virtualEntryPlugin(
                    () => `
import * as bootstrap from ${JSON.stringify(`alchemy/Runtime/Bootstrap/${name}`)};
export default bootstrap;
`,
                  ),
                ],
              },
              { format: "esm" },
            );
            expect(bareImports(result)).toEqual([]);
            expect(
              result.files.some(
                (file) =>
                  typeof file.content === "string" &&
                  file.content.includes("bootstrap"),
              ),
            ).toBe(true);
          } finally {
            yield* removeIsolatedProject(project);
          }
        }),
      { timeout: 120_000 },
    );
  }

  // An unresolvable import in a generated entry is a BUILD error with the
  // cause spelled out — never a warning that leaves the import external and
  // the deployed process dead at boot. (Doubles as the negative control for
  // the harness: without the `alchemy` link the project resolves nothing.)
  it.effect("an unresolvable import in a generated entry fails the build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = isolatedProject(
        "bootstrap-control",
        import.meta.filename,
      );
      yield* materializeIsolatedProject(project);
      yield* fs.remove(`${project.dir}/node_modules`, { recursive: true });
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      try {
        const result = yield* Effect.result(
          Bundle.build(
            {
              cwd: project.dir,
              input: project.main,
              platform: "node",
              plugins: [
                virtualEntryPlugin(
                  () => `
import * as bootstrap from "alchemy/Runtime/Bootstrap/Ecs";
export default bootstrap;
`,
                ),
              ],
            },
            { format: "esm" },
          ),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toContain(
            'imports "alchemy/Runtime/Bootstrap/Ecs", which cannot be resolved',
          );
        }
      } finally {
        yield* removeIsolatedProject(project);
      }
    }),
  );

  // Deliberate externals (runtime-provided modules such as `bun:*`,
  // `cloudflare:workers`) resolve to `{ external: true }`, not to nothing, so
  // the guard leaves them alone.
  it.effect("a declared external in a generated entry is not an error", () =>
    Effect.gen(function* () {
      const project = isolatedProject(
        "bootstrap-external",
        import.meta.filename,
      );
      yield* materializeIsolatedProject(project);
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      try {
        const result = yield* Bundle.build(
          {
            cwd: project.dir,
            input: project.main,
            platform: "node",
            external: ["bun:sqlite"],
            plugins: [
              virtualEntryPlugin(
                () => `
import { Database } from "bun:sqlite";
export default Database;
`,
              ),
            ],
          },
          { format: "esm" },
        );
        expect(bareImports(result)).toEqual([
          'import { Database } from "bun:sqlite";',
        ]);
      } finally {
        yield* removeIsolatedProject(project);
      }
    }),
  );
});
