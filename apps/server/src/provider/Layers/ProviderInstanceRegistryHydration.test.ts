import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

describe("deriveProviderInstanceConfigMap", () => {
  it("gives every built-in driver a default instance mirrored from legacy settings", () => {
    const configMap = deriveProviderInstanceConfigMap(decodeServerSettings({}));

    expect(Object.keys(configMap).sort()).toEqual([
      "claudeAgent",
      "codex",
      "cursor",
      "grok",
      "kiro",
      "opencode",
    ]);
  });

  it("mirrors providers.kiro into the default kiro instance", () => {
    const configMap = deriveProviderInstanceConfigMap(
      decodeServerSettings({
        providers: {
          kiro: { enabled: true, binaryPath: "~/.local/bin/kiro-cli", agent: "kiro_planner" },
        },
      }),
    );
    const entry = configMap[ProviderInstanceId.make("kiro")];

    expect(entry?.driver).toBe("kiro");
    expect(entry?.config).toMatchObject({
      enabled: true,
      binaryPath: "~/.local/bin/kiro-cli",
      agent: "kiro_planner",
    });
  });

  it("lets an explicit kiro instance win over the legacy mirror", () => {
    const configMap = deriveProviderInstanceConfigMap(
      decodeServerSettings({
        providers: { kiro: { binaryPath: "/legacy/kiro-cli" } },
        providerInstances: {
          kiro: {
            driver: "kiro",
            displayName: "Kiro (explicit)",
            config: { binaryPath: "/explicit/kiro-cli" },
          },
        },
      }),
    );
    const entry = configMap[ProviderInstanceId.make("kiro")];

    expect(entry?.displayName).toBe("Kiro (explicit)");
    expect(entry?.config).toEqual({ binaryPath: "/explicit/kiro-cli" });
  });

  it("keeps additional kiro instances alongside the default one", () => {
    const configMap = deriveProviderInstanceConfigMap(
      decodeServerSettings({
        providerInstances: {
          kiro_work: {
            driver: "kiro",
            displayName: "Kiro (work)",
            config: { homePath: "~/.kiro-work" },
          },
        },
      }),
    );

    expect(configMap[ProviderInstanceId.make("kiro_work")]?.driver).toBe("kiro");
    // The legacy mirror still supplies the default instance.
    expect(configMap[ProviderInstanceId.make("kiro")]?.driver).toBe("kiro");
  });
});
