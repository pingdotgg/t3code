import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { runBuildChild, type BuildChildOptions } from "../BuildChild.ts";
import { makeProject, run } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

it.each<{
  nodeEnv: string;
  env: BuildChildOptions["env"];
  expected: string;
}>([
  { nodeEnv: "test", env: undefined, expected: "production" },
  {
    nodeEnv: "development",
    env: { BUILD_GREETING: "hello" },
    expected: "production",
  },
  {
    nodeEnv: "test",
    env: { NODE_ENV: "development", BUILD_GREETING: "hello" },
    expected: "development",
  },
])(
  "builds with $expected from parent $nodeEnv and overrides $env",
  async ({ nodeEnv, env, expected }) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    const runner = new URL("../BuildChildRunner.ts", import.meta.url).href;
    const root = await makeProject({
      "core/BuildChildRunner.ts": `import ${JSON.stringify(runner)};`,
      "framework/source.ts": `
        import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};
        // Capture mode at module load, as framework plugins do.
        const mode = process.env.NODE_ENV;
        export const buildInChild = () => Effect.succeed({
          clientDirectory: mode,
          serverModules: undefined,
          externalWorkspaces: new Set([process.env.BUILD_GREETING ?? 'default']),
        });
      `,
    });
    const output = await run(
      runBuildChild({
        framework: "fixture",
        module: pathToFileURL(path.join(root, "framework/source.ts")).href,
        rootDir: root,
        config: {},
        env,
      }),
    );
    expect(output.clientDirectory).toBe(expected);
    expect(output.externalWorkspaces).toEqual(
      new Set([env?.BUILD_GREETING ?? "default"]),
    );
    expect(process.env.NODE_ENV).toBe(nodeEnv);
  },
);
