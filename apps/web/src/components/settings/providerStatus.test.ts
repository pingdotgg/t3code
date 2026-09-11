import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderSummary } from "./providerStatus";

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
  it.each([
    { state: "ready", overrides: {}, headline: "Authenticated", status: "ready" },
    { state: "error", overrides: { status: "error" }, headline: "Unavailable", status: "error" },
    {
      state: "warning",
      overrides: { status: "warning" },
      headline: "Needs attention",
      status: "warning",
    },
    {
      state: "disabled",
      overrides: { status: "disabled" },
      headline: "Disabled",
      status: "disabled",
    },
    {
      state: "disabled with a stale ready status",
      overrides: { enabled: false },
      headline: "Disabled",
      status: "disabled",
    },
    { state: "missing", overrides: { installed: false }, headline: "Not found", status: "error" },
    {
      state: "unauthenticated",
      overrides: { auth: { status: "unauthenticated" } },
      headline: "Not authenticated",
      status: "warning",
    },
  ] as const)(
    "keeps $state status accurate when hiding the subscription label",
    ({ overrides, headline, status }) => {
      expect(
        getProviderSummary({ ...provider, ...overrides }, { includeAuthLabel: false }),
      ).toMatchObject({ headline, status });
    },
  );

  it("includes the subscription label by default", () => {
    expect(getProviderSummary(provider).headline).toBe("Authenticated · ChatGPT");
  });

  it("reports ready providers with unknown authentication as available", () => {
    expect(getProviderSummary({ ...provider, auth: { status: "unknown" } })).toEqual({
      status: "ready",
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
      status: "error",
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
      status: "warning",
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
      status: "warning",
      headline: "Not authenticated",
      detail: "Run codex login.",
    });
  });

  it("treats a disabled provider status as disabled even before its enabled flag updates", () => {
    expect(getProviderSummary({ ...provider, status: "disabled" }).headline).toBe("Disabled");
  });
});
