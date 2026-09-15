import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderSummary, getProviderVersionAdvisoryPresentation } from "./providerStatus";

it("presents an unknown version only when the installer can check for updates", () => {
  const advisory = {
    status: "unknown" as const,
    currentVersion: "1.0.0",
    latestVersion: null,
    updateCommand: "scoop update main/claude-code",
    canUpdate: true,
    checkedAt: null,
    message: null,
  };
  expect(getProviderVersionAdvisoryPresentation(advisory)).toMatchObject({
    title: "Check for updates",
    isCheck: true,
  });
  expect(getProviderVersionAdvisoryPresentation({ ...advisory, canUpdate: false })).toBeNull();
  expect(getProviderVersionAdvisoryPresentation({ ...advisory, updateCommand: null })).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation({ ...advisory, status: "behind_latest" }),
  ).toMatchObject({ title: "Update available", isCheck: false });
});

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
