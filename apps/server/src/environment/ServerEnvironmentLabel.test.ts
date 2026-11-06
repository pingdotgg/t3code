import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

it.effect.each([
  { configured: "Laptop (work)", expected: "Laptop (work)" },
  { configured: "   ", expected: "laptop" },
])(
  "T3CODE_ENVIRONMENT_LABEL='$configured' names the environment $expected",
  ({ configured, expected }) =>
    Effect.gen(function* () {
      const label = yield* resolveServerEnvironmentLabel({ cwdBaseName: "project" });
      assert.strictEqual(label, expected);
    }).pipe(
      // win32 has no friendly-name probe, so the fallback is the hostname.
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Hostname, "laptop"),
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ProcessRunner.ProcessRunner)({}),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { T3CODE_ENVIRONMENT_LABEL: configured } }),
          ),
        ),
      ),
    ),
);
