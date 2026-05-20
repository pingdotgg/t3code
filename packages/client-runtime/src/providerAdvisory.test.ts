import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  beginProviderCompatibilityUpdate,
  canRunProviderCompatibilityUpdate,
  createProviderCompatibilityUpdateTracker,
  endProviderCompatibilityUpdate,
  getProviderCompatibilityUpdateCommand,
  getProviderCompatibilityUpdateRequest,
  isProviderCompatibilityUpdateRunning,
} from "./providerAdvisory.ts";

const codexProvider = {
  driver: ProviderDriverKind.make("codex"),
  instanceId: ProviderInstanceId.make("codex"),
  compatibilityAdvisory: {
    status: "broken",
    severity: "error",
    currentVersion: "0.128.0",
    message: "Known incompatible.",
    recommendedRange: ">=0.129.0",
    recommendedVersion: "0.129.0",
    canUpdate: true,
    updateCommand: "npm install -g @openai/codex@0.129.0",
    ranges: [],
  },
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "0.128.0",
    latestVersion: "0.130.0",
    checkedAt: "2026-05-13T00:00:00.000Z",
    message: "Update available.",
    updateCommand: "vp i -g @openai/codex",
    canUpdate: true,
  },
} satisfies Pick<
  ServerProvider,
  "driver" | "instanceId" | "compatibilityAdvisory" | "versionAdvisory"
>;

describe("provider advisory runtime", () => {
  it("derives manual targeted compatibility update commands from package install commands", () => {
    expect(
      getProviderCompatibilityUpdateCommand({
        ...codexProvider,
        compatibilityAdvisory: {
          ...codexProvider.compatibilityAdvisory,
          updateCommand: null,
        },
      }),
    ).toBe("vp i -g @openai/codex@0.129.0");
  });

  it("uses server capability, not manual command derivation, for one-click compatibility updates", () => {
    const provider = {
      ...codexProvider,
      compatibilityAdvisory: {
        ...codexProvider.compatibilityAdvisory,
        canUpdate: false,
        updateCommand: null,
      },
    };

    expect(getProviderCompatibilityUpdateCommand(provider)).toBe("vp i -g @openai/codex@0.129.0");
    expect(canRunProviderCompatibilityUpdate(provider)).toBe(false);
    expect(getProviderCompatibilityUpdateRequest(provider)).toBeNull();
  });

  it("builds targeted update requests when the server reports a runnable compatibility update", () => {
    expect(getProviderCompatibilityUpdateRequest(codexProvider)).toEqual({
      provider: ProviderDriverKind.make("codex"),
      instanceId: ProviderInstanceId.make("codex"),
      targetVersion: "0.129.0",
    });
  });

  it("tracks compatibility update state by provider instance", () => {
    const tracker = createProviderCompatibilityUpdateTracker();
    const started = beginProviderCompatibilityUpdate(tracker, codexProvider);

    expect(started.started).toBe(true);
    expect(isProviderCompatibilityUpdateRunning(started.tracker, codexProvider)).toBe(true);
    expect(beginProviderCompatibilityUpdate(started.tracker, codexProvider).started).toBe(false);
    expect(
      isProviderCompatibilityUpdateRunning(
        endProviderCompatibilityUpdate(started.tracker, codexProvider),
        codexProvider,
      ),
    ).toBe(false);
  });
});
