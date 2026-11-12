import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Bundle from "alchemy/Bundle/Bundle";
import * as Effect from "effect/Effect";
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

/** Each provider package's generated-entry bootstrap, and the package that ships it. */
const BOOTSTRAPS = [
  ["@alchemy.run/fly", "@alchemy.run/fly/Bootstrap"],
  ["@alchemy.run/hetzner", "@alchemy.run/hetzner/Bootstrap"],
  ["@alchemy.run/prisma", "@alchemy.run/prisma/Bootstrap"],
  ["@alchemy.run/railway", "@alchemy.run/railway/Bootstrap"],
] as const;

layer(NodeServices.layer)("provider package bootstraps", (it) => {
  // The contract the generated entries rely on, for bootstraps that ship in a
  // provider package: a consumer project with only `alchemy` and that package
  // installed (bun's isolated linker / pnpm) must be able to bundle it, with
  // the package's own dependencies resolving from its location.
  for (const [pkg, specifier] of BOOTSTRAPS) {
    it.effect(
      `${specifier} bundles from an isolated project`,
      () =>
        Effect.gen(function* () {
          const name = pkg.replace("@alchemy.run/", "");
          const project = isolatedProject(`bootstrap-${name}`, import.meta.filename, [pkg]);
          yield* materializeIsolatedProject(project);
          const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
          try {
            const result = yield* Bundle.build(
              {
                cwd: project.dir,
                input: project.main,
                platform: "node",
                external: ["bun", "bun:*"],
                resolve: { conditionNames: [...Bundle.BUN_CONDITION_NAMES] },
                plugins: [
                  virtualEntryPlugin(
                    () => `
import * as bootstrap from ${JSON.stringify(specifier)};
export default bootstrap;
`,
                  ),
                ],
              },
              { format: "esm" },
            );
            expect(bareImports(result)).toEqual([]);
          } finally {
            yield* removeIsolatedProject(project);
          }
        }),
      { tags: ["unit", "local"], timeout: 120_000 },
    );
  }
});
