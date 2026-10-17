import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderSummary,
  getProviderVersionAdvisoryPresentation,
  isAntigravitySignInUnchecked,
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

describe("Antigravity with unchecked sign-in", () => {
  const unchecked: ServerProvider = {
    ...provider,
    instanceId: ProviderInstanceId.make("antigravity"),
    driver: ProviderDriverKind.make("antigravity"),
    status: "warning",
    auth: { status: "unknown" },
    message: "Antigravity is installed. Google account access is not checked yet.",
  };

  it("reads as installed instead of needing attention", () => {
    expect(isAntigravitySignInUnchecked(unchecked)).toBe(true);
    expect(getProviderSummary(unchecked).headline).toBe("Installed · Sign-in required");
  });

  it.each(["oauth-personal", "oauth-business"])("applies to the %s method", (type) => {
    const withMethod = { ...unchecked, auth: { status: "unknown" as const, type } };
    expect(isAntigravitySignInUnchecked(withMethod)).toBe(true);
  });

  it.each(["gemini-api-key", "agent-platform"])(
    "keeps Needs attention for the %s method, which never signs in with Google",
    (type) => {
      const withMethod = { ...unchecked, auth: { status: "unknown" as const, type } };
      expect(isAntigravitySignInUnchecked(withMethod)).toBe(false);
      expect(getProviderSummary(withMethod).headline).toBe("Needs attention");
    },
  );

  it("keeps confirmed sign-out, probe failures and a missing install as they were", () => {
    expect(getProviderSummary({ ...unchecked, auth: { status: "unauthenticated" } }).headline).toBe(
      "Not authenticated",
    );
    expect(getProviderSummary({ ...unchecked, status: "error" }).headline).toBe("Unavailable");
    expect(getProviderSummary({ ...unchecked, installed: false }).headline).toBe("Not found");
    expect(isAntigravitySignInUnchecked({ ...unchecked, status: "error" })).toBe(false);
    expect(isAntigravitySignInUnchecked({ ...unchecked, installed: false })).toBe(false);
  });

  it("leaves other providers' unverified warnings as Needs attention", () => {
    const codex = { ...provider, status: "warning" as const, auth: { status: "unknown" as const } };
    expect(isAntigravitySignInUnchecked(codex)).toBe(false);
    expect(getProviderSummary(codex).headline).toBe("Needs attention");
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

describe("provider status copy", () => {
  it("surfaces an ACP-advertised authentication method", () => {
    const provider = {
      enabled: true,
      installed: true,
      status: "error",
      auth: { status: "unauthenticated", type: "agent", label: "Company login" },
      message: "Complete this authentication method on the server.",
    } as ServerProvider;

    expect(getProviderSummary(provider)).toEqual({
      headline: "Not authenticated · Company login",
      detail: "Complete this authentication method on the server.",
    });
  });
});
