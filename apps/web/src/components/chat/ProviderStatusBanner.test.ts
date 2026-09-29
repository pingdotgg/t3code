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

describe("compatibility banners", () => {
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

  it("keeps authentication failures ahead of compatibility warnings even without a probe message", () => {
    const unauthenticated: ServerProvider = {
      ...provider,
      status: "error",
      auth: { status: "unauthenticated" },
    };
    expect(getProviderStatusMessage(unauthenticated)).toBe(
      "Sign in via the CLI to authenticate again.",
    );
    expect(getProviderStatusMessage({ ...unauthenticated, message: "Credentials expired" })).toBe(
      "Credentials expired",
    );
  });
});
