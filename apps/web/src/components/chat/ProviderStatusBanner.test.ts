import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  dismissProviderStatusBannerForSession,
  getProviderStatusBannerKey,
  getProviderStatusDismissalKey,
  getProviderStatusMessage,
  isProviderStatusBannerDismissedForSession,
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

function shownAfterDismissing(dismissed: ServerProvider, shown: ServerProvider): boolean {
  return shouldShowProviderStatusBanner(
    shown,
    getProviderStatusBannerKey(shown) === getProviderStatusBannerKey(dismissed),
  );
}

describe("compatibility banners", () => {
  it("shows and dismisses a warning on a healthy provider, then clears it after policy relaxation", () => {
    expect(shouldShowProviderStatusBanner(provider, false)).toBe(true);
    expect(shownAfterDismissing(provider, provider)).toBe(false);
    expect(shownAfterDismissing(provider, { ...provider, version: "1.0.1" })).toBe(true);
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
    expect(shouldShowProviderStatusBanner(broken, false)).toBe(true);
    const timeoutOnly: ServerProvider = {
      ...broken,
      compatibilityAdvisory: {
        ...broken.compatibilityAdvisory!,
        status: "supported",
        message: null,
      },
    };
    expect(shownAfterDismissing(timeoutOnly, broken)).toBe(true);
    expect(shownAfterDismissing(broken, broken)).toBe(false);
    expect(
      shownAfterDismissing(broken, {
        ...broken,
        compatibilityAdvisory: { ...broken.compatibilityAdvisory!, message: "Use 1.14.20." },
      }),
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

describe("banner dismissal", () => {
  const { compatibilityAdvisory: _advisory, ...healthy } = provider;
  const failing: ServerProvider = {
    ...healthy,
    instanceId: ProviderInstanceId.make("codex-dismissal"),
    status: "error",
    message: "Could not start Codex CLI.",
  };

  it("keeps a dismissed status hidden in other views until the status changes", () => {
    const key = getProviderStatusDismissalKey("environment-a", failing);
    expect(isProviderStatusBannerDismissedForSession(key)).toBe(false);

    dismissProviderStatusBannerForSession(key);

    expect(
      isProviderStatusBannerDismissedForSession(
        getProviderStatusDismissalKey("environment-a", failing),
      ),
    ).toBe(true);
    expect(
      isProviderStatusBannerDismissedForSession(
        getProviderStatusDismissalKey("environment-a", { ...failing, message: "Codex exited." }),
      ),
    ).toBe(false);
  });

  it("keeps a dismissal to the environment it was taken in", () => {
    dismissProviderStatusBannerForSession(getProviderStatusDismissalKey("environment-c", failing));

    expect(
      isProviderStatusBannerDismissedForSession(
        getProviderStatusDismissalKey("environment-d", failing),
      ),
    ).toBe(false);
  });
});
