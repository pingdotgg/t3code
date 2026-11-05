import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveOnboardingSetup } from "./targetEnvironment.logic";

describe("resolveOnboardingSetup", () => {
  const computer = (id: string, phase: string) => ({
    environmentId: EnvironmentId.make(id),
    connection: { phase },
  });
  const local = computer("local", "connected");

  it("skips selected computers that will not connect on their own", () => {
    const environments = [
      local,
      computer("switched-off", "available"),
      computer("offline", "offline"),
      computer("failing", "reconnecting"),
      computer("old-client", "unsupported"),
    ];
    expect(
      resolveOnboardingSetup(
        environments,
        new Set(environments.map((environment) => environment.environmentId)),
      ),
    ).toEqual({
      ready: true,
      environmentIds: [local.environmentId],
      skippedIds: environments.slice(1).map((environment) => environment.environmentId),
    });
  });

  it("waits for a first connection attempt to settle", () => {
    const connecting = computer("new", "connecting");
    expect(
      resolveOnboardingSetup(
        [local, connecting],
        new Set([local.environmentId, connecting.environmentId]),
      ).ready,
    ).toBe(false);
  });

  // regression: #16887 onboarding Continue locked up on computers that won't connect
  it("is not ready without a connected selection", () => {
    expect(resolveOnboardingSetup([local], new Set()).ready).toBe(false);
    expect(
      resolveOnboardingSetup([computer("off", "available")], new Set([EnvironmentId.make("off")]))
        .ready,
    ).toBe(false);
  });
});
