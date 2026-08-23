import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getOnboardingProviderState,
  selectOnboardingProvidersByDriver,
} from "./providerReadiness.logic";

const readyCodex: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getOnboardingProviderState", () => {
  it("treats an enabled Codex provider with ready status and unknown authentication as ready", () => {
    expect(getOnboardingProviderState(readyCodex)).toBe("ready");
  });

  it("treats authenticated providers as ready only when their provider status is ready", () => {
    expect(getOnboardingProviderState({ ...readyCodex, auth: { status: "authenticated" } })).toBe(
      "ready",
    );
    expect(
      getOnboardingProviderState({
        ...readyCodex,
        auth: { status: "authenticated" },
        status: "error",
      }),
    ).toBe("attention");
    expect(
      getOnboardingProviderState({
        ...readyCodex,
        auth: { status: "authenticated" },
        status: "warning",
      }),
    ).toBe("attention");
  });

  it("offers sign-in only when the server reports an authentication failure", () => {
    expect(
      getOnboardingProviderState({
        ...readyCodex,
        status: "error",
        auth: { status: "unauthenticated" },
      }),
    ).toBe("signIn");
    expect(getOnboardingProviderState({ ...readyCodex, status: "error" })).toBe("attention");
    expect(getOnboardingProviderState({ ...readyCodex, status: "warning" })).toBe("attention");
  });

  it("does not offer installation or sign-in for disabled providers", () => {
    expect(getOnboardingProviderState({ ...readyCodex, enabled: false, installed: false })).toBe(
      "disabled",
    );
    expect(getOnboardingProviderState({ ...readyCodex, status: "disabled" })).toBe("disabled");
  });

  it("offers installation only when an enabled provider is missing", () => {
    expect(getOnboardingProviderState({ ...readyCodex, installed: false, status: "error" })).toBe(
      "install",
    );
  });

  it("waits for a provider snapshot before offering an action", () => {
    expect(getOnboardingProviderState(undefined)).toBe("checking");
  });
});

describe("selectOnboardingProvidersByDriver", () => {
  it("prefers a ready instance with unknown authentication to an unauthenticated instance", () => {
    const signedOutCodex: ServerProvider = {
      ...readyCodex,
      instanceId: ProviderInstanceId.make("codex_work"),
      status: "error",
      auth: { status: "unauthenticated" },
    };

    expect(selectOnboardingProvidersByDriver([signedOutCodex, readyCodex]).get("codex")).toBe(
      readyCodex,
    );
  });

  it("prefers a provider with an actionable sign-in over a failed provider", () => {
    const failedCodex: ServerProvider = { ...readyCodex, status: "error" };
    const signedOutCodex: ServerProvider = {
      ...readyCodex,
      instanceId: ProviderInstanceId.make("codex_work"),
      status: "error",
      auth: { status: "unauthenticated" },
    };

    expect(selectOnboardingProvidersByDriver([failedCodex, signedOutCodex]).get("codex")).toBe(
      signedOutCodex,
    );
  });

  it("prefers installed providers over missing or disabled instances", () => {
    const disabledCodex: ServerProvider = { ...readyCodex, enabled: false };
    const missingCodex: ServerProvider = {
      ...readyCodex,
      instanceId: ProviderInstanceId.make("codex_work"),
      installed: false,
      status: "error",
    };

    expect(
      selectOnboardingProvidersByDriver([disabledCodex, missingCodex, readyCodex]).get("codex"),
    ).toBe(readyCodex);
  });

  it("handles provider snapshots that have not arrived", () => {
    expect(selectOnboardingProvidersByDriver(undefined).size).toBe(0);
  });
});
