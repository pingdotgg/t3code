import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderSummary,
  getProviderVersionAdvisoryPresentation,
  isAntigravityUncheckedAuth,
} from "./providerStatus";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", label: "ChatGPT" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getProviderSummary", () => {
  it("reports ready providers with unknown authentication as available", () => {
    expect(getProviderSummary({ ...provider, auth: { status: "unknown" } })).toEqual({
      headline: "Available",
      detail: null,
    });
  });

  it("does not hide a provider error behind a previous authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        message: "The provider process failed to start.",
      }),
    ).toEqual({
      headline: "Unavailable",
      detail: "The provider process failed to start.",
    });
  });

  it("does not hide a provider warning behind an authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "warning",
        message: "The provider version is unsupported.",
      }),
    ).toEqual({
      headline: "Needs attention",
      detail: "The provider version is unsupported.",
    });
  });

  it("treats healthy Antigravity with unchecked Google auth as sign-in required", () => {
    const message = "Antigravity is installed. Google account access is not checked yet.";
    const antigravity = {
      ...provider,
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      status: "warning" as const,
      auth: { status: "unknown" as const, type: "oauth-personal" },
      message,
    };

    expect(isAntigravityUncheckedAuth(antigravity)).toBe(true);
    expect(getProviderSummary(antigravity)).toEqual({
      headline: "Installed · Sign-in required",
      detail: message,
    });
    expect(
      isAntigravityUncheckedAuth({
        ...antigravity,
        auth: { status: "unknown", type: "oauth-business" },
      }),
    ).toBe(true);
    expect(
      isAntigravityUncheckedAuth({
        ...antigravity,
        auth: { status: "unknown" },
      }),
    ).toBe(true);
    expect(
      isAntigravityUncheckedAuth({
        ...antigravity,
        status: "error",
        message: "Antigravity could not complete its local health check.",
      }),
    ).toBe(false);
    expect(
      getProviderSummary({
        ...antigravity,
        status: "error",
        message: "Antigravity could not complete its local health check.",
      }),
    ).toEqual({
      headline: "Unavailable",
      detail: "Antigravity could not complete its local health check.",
    });
    expect(
      getProviderSummary({
        ...provider,
        status: "warning",
        auth: { status: "unknown" },
        message: "The provider version is unsupported.",
      }),
    ).toEqual({
      headline: "Needs attention",
      detail: "The provider version is unsupported.",
    });
  });

  it("does not treat credential Antigravity methods as Google sign-in required", () => {
    const message = "The provider is installed, but the server could not fully verify it.";
    for (const type of ["gemini-api-key", "agent-platform"] as const) {
      const antigravity = {
        ...provider,
        instanceId: ProviderInstanceId.make("antigravity"),
        driver: ProviderDriverKind.make("antigravity"),
        status: "warning" as const,
        auth: { status: "unknown" as const, type },
        message,
      };

      expect(isAntigravityUncheckedAuth(antigravity)).toBe(false);
      expect(getProviderSummary(antigravity)).toEqual({
        headline: "Needs attention",
        detail: message,
      });
    }
  });

  it("keeps a confirmed Antigravity sign-out as not authenticated", () => {
    const signedOut = {
      ...provider,
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      status: "warning" as const,
      auth: { status: "unauthenticated" as const },
      message: "Sign in with Google to use Antigravity.",
    };
    expect(isAntigravityUncheckedAuth(signedOut)).toBe(false);
    expect(getProviderSummary(signedOut)).toEqual({
      headline: "Not authenticated",
      detail: "Sign in with Google to use Antigravity.",
    });
  });

  it("keeps authentication failures actionable when their provider status is error", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Run codex login.",
      }),
    ).toEqual({
      headline: "Not authenticated",
      detail: "Run codex login.",
    });
  });

  it("treats a disabled provider status as disabled even before its enabled flag updates", () => {
    expect(getProviderSummary({ ...provider, status: "disabled" }).headline).toBe("Disabled");
  });
});

it("does not suggest copying a command that installs an incompatible latest version", () => {
  const advisory = {
    status: "behind_latest" as const,
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    updateCommand: "npm install -g fixture@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "supported" as const,
    latestVersionStatus: "broken" as const,
    message: null,
    recommendedRange: null,
    recommendedVersion: null,
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation(advisory, { ...compatibility, status: "broken" }, false),
  ).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation(advisory, {
      ...compatibility,
      latestVersionStatus: "supported",
    }),
  ).not.toBeNull();
});

it("shows compatibility in the version popover even when the installed version is current", () => {
  const advisory = {
    status: "current" as const,
    currentVersion: "2.0.0",
    latestVersion: "2.0.0",
    updateCommand: "npm install -g fixture@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "broken" as const,
    latestVersionStatus: "broken" as const,
    message: "This version drops turns. Use 1.9.0.",
    recommendedRange: null,
    recommendedVersion: "1.9.0",
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toEqual({
    title: "Known broken version",
    detail: compatibility.message,
    updateCommand: null,
    emphasis: "strong",
    targetVersion: "1.9.0",
  });
  expect(
    getProviderVersionAdvisoryPresentation(undefined, {
      ...compatibility,
      status: "graceful",
      recommendedVersion: null,
      recommendedRange: ">=2.1.0",
      message: null,
    }),
  ).toEqual({
    title: "Limited support",
    detail: "Use >=2.1.0 for full support.",
    updateCommand: null,
    emphasis: "normal",
    targetVersion: null,
  });
});
