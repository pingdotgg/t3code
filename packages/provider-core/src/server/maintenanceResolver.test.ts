// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import {
  makeTargetedProviderUpdateAction,
  makeProviderMaintenanceCapabilities,
} from "./maintenanceResolver.ts";
import { driver } from "./maintenanceResolver.helpers2.testkit.ts";

it("pins only owned package-manager installs and preserves their execution context", () => {
  const capabilities = makeProviderMaintenanceCapabilities({
    provider: driver("codex"),
    packageName: "@openai/codex",
    updateExecutable: "npm",
    updateLockKey: "npm-global:/opt/node",
    updateArgs: [
      "install",
      "-g",
      "--prefix",
      "/opt/node",
      "--allow-scripts=@openai/codex",
      "@openai/codex@latest",
    ],
    env: { PATH: "/opt/node/bin" },
  });
  const pinned = makeTargetedProviderUpdateAction(capabilities, "2.0.0");
  expect(pinned).toMatchObject({
    executable: "npm",
    lockKey: capabilities.update?.lockKey,
    env: capabilities.update?.env,
    args: [
      "install",
      "-g",
      "--prefix",
      "/opt/node",
      "--allow-scripts=@openai/codex",
      "@openai/codex@2.0.0",
    ],
  });
  expect(pinned?.command).toContain("@openai/codex@2.0.0");
  for (const lockKey of ["codex-native", "homebrew", "manual"]) {
    expect(
      makeTargetedProviderUpdateAction(
        { ...capabilities, update: { ...capabilities.update!, lockKey } },
        "2.0.0",
      ),
    ).toBeNull();
  }
  expect(makeTargetedProviderUpdateAction(capabilities, "2.0.0; rm -rf /")).toBeNull();
});
