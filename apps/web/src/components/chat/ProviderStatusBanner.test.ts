import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  dismissProviderStatusBannerForSession,
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

describe("compatibility advisories", () => {
  it("never raise the banner or replace the provider's own status message", () => {
    expect(shouldShowProviderStatusBanner(provider, false)).toBe(false);
    const broken: ServerProvider = {
      ...provider,
      driver: ProviderDriverKind.make("opencode"),
      status: "error",
      auth: { status: "unknown" },
      message: "Failed to load OpenCode provider inventory: Timed out waiting for server start.",
      compatibilityAdvisory: {
        status: "broken",
        message: "This provider version is known to be incompatible. Use 1.14.19.",
        recommendedVersion: "1.14.19",
        recommendedRange: ">=1.14.19 <2.0.0",
      },
    };
    expect(shouldShowProviderStatusBanner(broken, false)).toBe(true);
    expect(getProviderStatusMessage(broken)).toBe(broken.message);
  });

  it("says Orbit installs a CLI that is missing from PATH", () => {
    const { message: _message, ...missing } = {
      ...provider,
      installed: false,
      status: "error" as const,
      message: undefined,
    };
    expect(getProviderStatusMessage(missing)).toBe(
      "Codex is not on this environment's PATH. Orbit installs it.",
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
