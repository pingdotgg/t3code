import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";

import { scannableInstanceConfigs } from "./UsageService.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

describe("scannableInstanceConfigs", () => {
  it("falls back to the legacy per-driver settings when no instances are configured", () => {
    const configs = scannableInstanceConfigs(decodeSettings({}));
    NodeAssert.deepStrictEqual(
      configs.map((config) => config.driver),
      ["claudeAgent", "codex"],
    );
  });

  it("includes every configured Claude instance, not just the default one", () => {
    const settings = decodeSettings({
      providers: { claudeAgent: { homePath: "~/.claude" } },
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent_work")]: {
          driver: "claudeAgent",
          config: { homePath: "/tmp/claude-work" },
        },
      },
    });

    const homePaths = scannableInstanceConfigs(settings)
      .filter((config) => config.driver === "claudeAgent")
      .map((config) => config.settings.homePath)
      .sort();

    NodeAssert.deepStrictEqual(homePaths, ["/tmp/claude-work", "~/.claude"]);
  });

  // An explicit entry under the default id is the user's override of the
  // legacy blob; hydration lets it win, so the scan must not read both.
  it("prefers an explicit default-id instance over the legacy blob", () => {
    const settings = decodeSettings({
      providers: { claudeAgent: { homePath: "/tmp/legacy" } },
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: "claudeAgent",
          config: { homePath: "/tmp/explicit" },
        },
      },
    });

    const homePaths = scannableInstanceConfigs(settings)
      .filter((config) => config.driver === "claudeAgent")
      .map((config) => config.settings.homePath);

    NodeAssert.deepStrictEqual(homePaths, ["/tmp/explicit"]);
  });

  // Forks and rollbacks leave entries for drivers this build cannot read.
  it("ignores instances whose driver has no transcript reader", () => {
    const settings = decodeSettings({
      providerInstances: {
        [ProviderInstanceId.make("opencode_local")]: { driver: "opencode", config: {} },
        [ProviderInstanceId.make("ollama_local")]: { driver: "ollama", config: {} },
      },
    });

    NodeAssert.deepStrictEqual(
      scannableInstanceConfigs(settings).map((config) => config.driver),
      ["claudeAgent", "codex"],
    );
  });
});
