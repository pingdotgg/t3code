import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarProviderFilterState,
  sidebarProviderInstanceKey,
} from "./sidebarProviderFilters";

function provider(instanceId: string, driverKind: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driverKind),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-23T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

function config(providers: readonly ServerProvider[]): ServerConfig {
  return { providers } as ServerConfig;
}

describe("buildSidebarProviderFilterState", () => {
  it("keeps provider instance lookups scoped to their environment", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const state = buildSidebarProviderFilterState(
      new Map([
        [localEnvironmentId, config([provider("shared", "codex")])],
        [remoteEnvironmentId, config([provider("shared", "claudeAgent")])],
      ]),
    );

    expect(
      state.driverKindByScopedInstanceKey.get(
        sidebarProviderInstanceKey(localEnvironmentId, ProviderInstanceId.make("shared")),
      ),
    ).toBe("codex");
    expect(
      state.driverKindByScopedInstanceKey.get(
        sidebarProviderInstanceKey(remoteEnvironmentId, ProviderInstanceId.make("shared")),
      ),
    ).toBe("claudeAgent");
  });

  it("includes provider sources that exist only on remote environments", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const state = buildSidebarProviderFilterState(
      new Map([
        [localEnvironmentId, config([provider("codex", "codex")])],
        [remoteEnvironmentId, config([provider("grok-remote", "grok")])],
      ]),
    );

    expect(state.sources.map((source) => source.driverKind)).toEqual(["codex", "grok"]);
  });
});
