import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canLoadBalanceToEnvironment } from "./load-balancing.ts";

describe("canLoadBalanceToEnvironment", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const driver = ProviderDriverKind.make("codex");
  const projectId = ProjectId.make("project");
  const provider = {
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  } satisfies ServerProvider;
  const settings = DEFAULT_SERVER_SETTINGS;
  const request = { projectId, providerInstanceId: instanceId, providerDriver: driver };

  it("accepts a machine whose matching provider is ready", () => {
    expect(
      canLoadBalanceToEnvironment({
        ...request,
        providers: [provider],
        settings,
      }),
    ).toBe(true);
    expect(
      canLoadBalanceToEnvironment({
        ...request,
        providerInstanceId: null,
        providerDriver: null,
        providers: [provider],
        settings,
      }),
    ).toBe(true);
  });

  it("rejects machines that cannot run the provider", () => {
    const rejected: ReadonlyArray<ServerProvider> = [
      { ...provider, instanceId: ProviderInstanceId.make("claude") },
      { ...provider, installed: false },
      { ...provider, status: "error" },
      { ...provider, auth: { status: "unauthenticated" } },
      { ...provider, availability: "unavailable" },
    ];
    for (const candidate of rejected) {
      expect(
        canLoadBalanceToEnvironment({
          ...request,
          providers: [candidate],
          settings,
        }),
      ).toBe(false);
    }
    expect(canLoadBalanceToEnvironment({ ...request, providers: undefined, settings })).toBe(false);
  });

  it("lets the destination project switch the provider off", () => {
    expect(
      canLoadBalanceToEnvironment({
        ...request,
        providers: [provider],
        settings: {
          ...settings,
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
          },
        },
      }),
    ).toBe(false);
  });
});
