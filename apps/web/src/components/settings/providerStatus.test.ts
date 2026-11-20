import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderCompatibilityNote,
  getProviderSummary,
  getProviderStatusKey,
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

  it("presents an unchecked Google sign-in neutrally without claiming authentication is required", () => {
    for (const auth of [unchecked.auth, { status: "unknown", type: "oauth-personal" }] as const) {
      const candidate = { ...unchecked, auth };
      expect.soft(getProviderSummary(candidate)).toEqual({
        headline: "Installed · Sign-in not checked",
        detail: unchecked.message,
      });
      expect(getProviderStatusKey(candidate)).toBe("neutral");
    }
  });

  // regression: #18623 neutral unchecked-sign-in display must not mask real warnings
  it("preserves actionable warnings, failures and disabled states outside unchecked Google sign-in", () => {
    const cases = [
      {
        name: "confirmed sign-out",
        change: { auth: { status: "unauthenticated" } },
        headline: "Not authenticated",
        status: "warning",
      },
      {
        name: "warning despite known authentication",
        change: { auth: { status: "authenticated" } },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "probe failure",
        change: { status: "error" },
        headline: "Unavailable",
        status: "error",
      },
      {
        name: "missing CLI",
        change: { installed: false },
        headline: "Not found",
        status: "warning",
      },
      {
        name: "API key authentication",
        change: { auth: { status: "unknown", type: "gemini-api-key" } },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "Agent Platform authentication",
        change: { auth: { status: "unknown", type: "agent-platform" } },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "another provider",
        change: { driver: provider.driver },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "disabled provider",
        change: { enabled: false },
        headline: "Disabled",
        status: "disabled",
      },
    ] as const;
    for (const { name, change, headline, status } of cases) {
      const candidate = { ...unchecked, ...change };
      expect.soft(getProviderSummary(candidate).headline, name).toBe(headline);
      expect.soft(getProviderStatusKey(candidate), name).toBe(status);
    }
  });
});

it("describes a version Orbit should change in one quiet line", () => {
  const compatibility = {
    status: "graceful" as const,
    latestVersionStatus: "graceful" as const,
    message: null,
    recommendedRange: ">=2.0.18",
    recommendedVersion: null,
  };
  expect(getProviderCompatibilityNote(compatibility)).toBe(
    "Limited support · Use >=2.0.18 for full support.",
  );
  expect(
    getProviderCompatibilityNote({
      ...compatibility,
      status: "broken",
      message: "This version drops turns.",
    }),
  ).toBe("Known broken version · This version drops turns.");
  expect(getProviderCompatibilityNote({ ...compatibility, status: "supported" })).toBeNull();
  expect(getProviderCompatibilityNote(undefined)).toBeNull();
});
