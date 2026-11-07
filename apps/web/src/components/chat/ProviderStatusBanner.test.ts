import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  getProviderStatusBannerKey,
  getProviderStatusMessage,
  shouldShowProviderStatusBanner,
} from "./ProviderStatusBanner";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-22T00:00:00Z",
  models: [],
  skills: [],
  slashCommands: [],
  compatibilityAdvisory: {
    status: "unsupported",
    message: "Unsupported version. Use 2.0.0.",
    recommendedVersion: "2.0.0",
    recommendedRange: null,
  },
};

describe("provider status banners", () => {
  it("keeps initial checks quiet without hiding completed probe failures", () => {
    const { compatibilityAdvisory: _compatibilityAdvisory, ...base } = provider;
    const checking: ServerProvider = {
      ...base,
      installed: false,
      version: null,
      status: "checking",
      auth: { status: "unknown" },
      message: "Codex provider status has not been checked in this session yet.",
    };
    expect(shouldShowProviderStatusBanner(checking, null)).toBe(false);
    expect(
      shouldShowProviderStatusBanner({ ...checking, message: "Checking installation." }, null),
    ).toBe(false);
    expect(
      shouldShowProviderStatusBanner(
        { ...checking, installed: true, status: "ready", auth: { status: "authenticated" } },
        null,
      ),
    ).toBe(false);
    for (const failure of [
      { status: "error", installed: false, message: "Could not start Codex CLI." },
      { status: "error", installed: true, message: "Codex provider probe failed." },
      { status: "error", installed: true, message: "Timed out while checking Codex." },
      {
        status: "warning",
        installed: true,
        message: "Codex did not return its model catalog in time.",
      },
      { status: "warning", installed: false, message: checking.message },
      { status: "error", auth: { status: "unauthenticated" }, message: "Run codex login." },
    ] as const) {
      expect(shouldShowProviderStatusBanner({ ...checking, ...failure }, null)).toBe(true);
    }
    expect(shouldShowProviderStatusBanner({ ...checking, status: "disabled" }, null)).toBe(false);
    expect(
      shouldShowProviderStatusBanner(
        {
          ...checking,
          compatibilityAdvisory: { ...provider.compatibilityAdvisory!, status: "broken" },
        },
        null,
      ),
    ).toBe(true);
  });

  it("shows and dismisses a warning on a healthy provider, then clears it after policy relaxation", () => {
    expect(shouldShowProviderStatusBanner(provider, null)).toBe(true);
    expect(shouldShowProviderStatusBanner(provider, getProviderStatusBannerKey(provider))).toBe(
      false,
    );
    expect(
      shouldShowProviderStatusBanner(
        { ...provider, version: "1.0.1" },
        getProviderStatusBannerKey(provider),
      ),
    ).toBe(true);
    const relaxed: ServerProvider = {
      ...provider,
      compatibilityAdvisory: {
        ...provider.compatibilityAdvisory!,
        status: "supported",
        message: null,
      },
    };
    expect(getProviderStatusBannerKey(relaxed)).toBeNull();
    expect(getProviderStatusBannerKey({ ...provider, status: "disabled" })).toBeNull();
    expect(
      getProviderStatusBannerKey({
        ...provider,
        compatibilityAdvisory: { ...provider.compatibilityAdvisory!, status: "graceful" },
      }),
    ).toBeNull();
  });

  it("shows downgrade guidance instead of a broken OpenCode inventory timeout", () => {
    const message = "This provider version is known to be incompatible. Use 1.14.19.";
    const broken: ServerProvider = {
      ...provider,
      driver: ProviderDriverKind.make("opencode"),
      version: "2.0.3",
      status: "error",
      auth: { status: "unknown" },
      message: "Failed to load OpenCode provider inventory: Timed out waiting for server start.",
      compatibilityAdvisory: {
        status: "broken",
        message,
        recommendedVersion: "1.14.19",
        recommendedRange: ">=1.14.19 <2.0.0",
      },
    };
    expect(shouldShowProviderStatusBanner(broken, null)).toBe(true);
    const timeoutOnly: ServerProvider = {
      ...broken,
      compatibilityAdvisory: {
        ...broken.compatibilityAdvisory!,
        status: "supported",
        message: null,
      },
    };
    expect(shouldShowProviderStatusBanner(broken, getProviderStatusBannerKey(timeoutOnly))).toBe(
      true,
    );
    expect(shouldShowProviderStatusBanner(broken, getProviderStatusBannerKey(broken))).toBe(false);
    expect(
      shouldShowProviderStatusBanner(
        {
          ...broken,
          compatibilityAdvisory: { ...broken.compatibilityAdvisory!, message: "Use 1.14.20." },
        },
        getProviderStatusBannerKey(broken),
      ),
    ).toBe(true);
    expect(getProviderStatusMessage(broken)).toBe(message);
    expect(
      getProviderStatusMessage({
        ...broken,
        compatibilityAdvisory: {
          ...broken.compatibilityAdvisory!,
          status: "supported",
          message: null,
        },
      }),
    ).toBe(broken.message);
    expect(getProviderStatusMessage({ ...broken, auth: { status: "unauthenticated" } })).toBe(
      broken.message,
    );
  });
});
