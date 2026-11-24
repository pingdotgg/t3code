// Multi-member Team E2E configuration. See docs/teams/testing-e2e.md.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { web } from "@e2e-dev/web";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { E2EConfig } from "e2e";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

const resolved = await Effect.gen(function* () {
  const path = yield* Path.Path;
  const env = yield* HostProcess.Environment;
  const scripts = yield* path.fromFileUrl(new URL(".", import.meta.url));
  return {
    node: yield* HostProcess.ExecutablePath,
    appDir: path.resolve(scripts, env.T3_SCENARIO_APP_DIR ?? ".."),
    teamHomeRoot: path.resolve(scripts, "../.t3/scenarios-team"),
    startVite: path.join(scripts, "scenarios/team/start-vite.ts"),
    inheritEnv: (env.T3_SCENARIO_INHERIT_ENV ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  };
}).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

export const TEAM_APP_DIR = resolved.appDir;
export const TEAM_SCENARIOS_HOME = resolved.teamHomeRoot;
const LOOPBACK = "127.0.0.1";

export default {
  tests: "scenarios/team/**/*.e2e.ts",
  targets: [
    {
      name: "team-web",
      engine: web({ viewport: { width: 1280, height: 800 } }),
      app: {
        url: `http://${LOOPBACK}:0`,
        readyUrl: `http://${LOOPBACK}:{port}/`,
        command: {
          executable: resolved.node,
          args: [resolved.startVite, LOOPBACK, "{port}"],
          cwd: TEAM_APP_DIR,
          inheritEnv: resolved.inheritEnv,
          startupTimeout: 180_000,
          log: ".e2e/team-vite.log",
        },
      },
    },
  ],
  workers: 1,
  timeout: 300_000,
  assertionTimeout: 20_000,
  reporters: ["list", "markdown"],
} satisfies E2EConfig;
