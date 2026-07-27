import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";

import { nextDisabledMcpServers, planDisabledMcpServersWrite } from "./McpServerToggle.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const settingsWith = (overrides: Record<string, unknown>) => decodeSettings({ ...overrides });

describe("nextDisabledMcpServers", () => {
  it("adds a name once when disabling", () => {
    assert.deepEqual(nextDisabledMcpServers(["a"], "b", false), ["a", "b"]);
    assert.deepEqual(nextDisabledMcpServers(["a", "b"], "b", false), ["a", "b"]);
  });

  it("drops the name when enabling", () => {
    assert.deepEqual(nextDisabledMcpServers(["a", "b"], "b", true), ["a"]);
    assert.deepEqual(nextDisabledMcpServers([], "b", true), []);
  });
});

describe("planDisabledMcpServersWrite", () => {
  it("patches an explicit provider instance", () => {
    const settings = settingsWith({
      providerInstances: {
        "claude-work": {
          driver: "claudeAgent",
          config: { binaryPath: "claude", disabledMcpServers: ["alpaca"] },
        },
      },
    });

    const plan = planDisabledMcpServersWrite(settings, {
      instanceId: "claude-work",
      name: "codegraph",
      enabled: false,
    });

    assert.equal(plan.kind, "instance");
    if (plan.kind !== "instance") return;
    const instance = plan.patch.providerInstances?.[ProviderInstanceId.make("claude-work")] as
      | { readonly config?: Record<string, unknown> }
      | undefined;
    assert.deepEqual(instance?.config?.disabledMcpServers, ["alpaca", "codegraph"]);
  });

  it("patches the legacy provider blob for a default instance id", () => {
    const settings = settingsWith({
      providers: { codex: { binaryPath: "codex", disabledMcpServers: ["a", "b"] } },
    });

    const plan = planDisabledMcpServersWrite(settings, {
      instanceId: "codex",
      name: "b",
      enabled: true,
    });

    assert.equal(plan.kind, "legacyProvider");
    if (plan.kind !== "legacyProvider") return;
    assert.deepEqual(plan.patch.providers?.codex?.disabledMcpServers, ["a"]);
  });

  it("rejects instances whose driver has no disable list", () => {
    const settings = settingsWith({
      providerInstances: {
        "cursor-1": { driver: "cursor", config: { binaryPath: "cursor-agent" } },
      },
    });

    assert.equal(
      planDisabledMcpServersWrite(settings, {
        instanceId: "cursor-1",
        name: "codegraph",
        enabled: false,
      }).kind,
      "unsupported",
    );
    assert.equal(
      planDisabledMcpServersWrite(settings, {
        instanceId: "unknown-instance",
        name: "codegraph",
        enabled: false,
      }).kind,
      "unsupported",
    );
  });
});
