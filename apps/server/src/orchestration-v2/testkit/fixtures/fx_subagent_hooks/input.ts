import { SUBAGENT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

/** Real files, so each child reads before replying past fx's 200-byte ACP preview. */
export function fxSubagentHooksInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "auto",
    workspaceFiles: {
      "package.json": `${JSON.stringify(
        {
          name: "fx-hooks-fixture",
          version: "1.4.0",
          type: "module",
          packageManager: "pnpm@10.12.0",
          engines: { node: ">=22" },
          scripts: {
            build: "tsc -p tsconfig.json",
            dev: "vite",
            test: "vitest run",
            lint: "oxlint .",
            typecheck: "tsc --noEmit",
          },
          dependencies: { effect: "^4.0.0", react: "^19.1.0" },
          devDependencies: { typescript: "^5.9.0", vite: "^7.0.0", vitest: "^4.0.0" },
        },
        null,
        2,
      )}\n`,
      "tsconfig.json": `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noUncheckedIndexedAccess: true,
            exactOptionalPropertyTypes: true,
            jsx: "react-jsx",
            outDir: "dist",
          },
          include: ["src"],
        },
        null,
        2,
      )}\n`,
    },
    steps: [{ type: "message", text: SUBAGENT_PROMPT }],
  };
}
