import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

const resolveOnMac = (env: Record<string, string>) =>
  resolveServerEnvironmentLabel({ cwdBaseName: "project" }).pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Hostname, "mini.local"),
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({
        run: () =>
          Effect.succeed({
            stdout: "mini\n",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      }),
    ),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

it.layer(NodeServices.layer)("resolveServerEnvironmentLabel", (it) => {
  it.effect("T3CODE_ENVIRONMENT_LABEL replaces the machine name unless blank", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* resolveOnMac({}), "mini");
      assert.strictEqual(yield* resolveOnMac({ T3CODE_ENVIRONMENT_LABEL: "  Alex  " }), "Alex");
      assert.strictEqual(yield* resolveOnMac({ T3CODE_ENVIRONMENT_LABEL: "   " }), "mini");
    }),
  );
});
