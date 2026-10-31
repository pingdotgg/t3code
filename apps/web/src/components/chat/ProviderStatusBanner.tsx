import { type ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { BotOffIcon, CircleAlertIcon, KeyRoundIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "../ui/button";
import { formatProviderDriverKindLabel } from "../../providerModels";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

function getIncompatibleVersion(status: ServerProvider) {
  const compatibility = status.compatibilityAdvisory;
  if (status.status === "error" && status.auth.status === "unauthenticated") return null;
  return compatibility?.status === "broken" ||
    (status.status === "ready" && compatibility?.status === "unsupported")
    ? compatibility
    : null;
}

export function getProviderStatusBannerKey(status: ServerProvider | null): string | null {
  if (!status || status.status === "disabled") return null;
  const incompatible = getIncompatibleVersion(status);
  if (incompatible) {
    return [
      status.instanceId,
      incompatible.status,
      status.version ?? "",
      incompatible.message ?? "",
    ].join("\u0000");
  }
  if (status.status === "ready") return null;
  // Antigravity validates credentials at session start; unknown restart auth is not failure.
  if (
    status.driver === "antigravity" &&
    status.installed &&
    status.status === "warning" &&
    status.auth.status === "unknown"
  ) {
    return null;
  }
  return [status.instanceId, status.status, status.auth.status, status.message ?? ""].join(
    "\u0000",
  );
}

export function shouldShowProviderStatusBanner(
  status: ServerProvider | null,
  dismissedBannerKey: string | null,
): boolean {
  const bannerKey = getProviderStatusBannerKey(status);
  return bannerKey !== null && bannerKey !== dismissedBannerKey;
}

export function hasProviderSetup(status: ServerProvider): boolean {
  return (
    status.driver === "antigravity" ||
    status.setup?.canAuthenticate === true ||
    status.setup?.canInstall === true
  );
}

export function getProviderStatusMessage(status: ServerProvider): string {
  if (
    status.auth.status !== "unauthenticated" &&
    status.compatibilityAdvisory?.status === "broken" &&
    status.compatibilityAdvisory.message
  ) {
    return status.compatibilityAdvisory.message;
  }
  if (status.message) return status.message;
  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  if (!status.installed && hasProviderSetup(status)) {
    return `Open provider setup to install ${formatProviderDriverKindLabel(status.driver)} on this environment.`;
  }
  if (status.auth.status === "unauthenticated") {
    if (hasProviderSetup(status)) {
      return status.driver === "antigravity"
        ? "Open provider setup to sign in with Google."
        : "Open provider setup to sign in.";
    }
    return "Sign in via the CLI to authenticate again.";
  }
  return status.status === "ready"
    ? "No models are available for this provider."
    : status.status === "error"
      ? `${providerName} provider is unavailable.`
      : `${providerName} provider has limited availability.`;
}

/**
 * The selected provider's status as a tray notice: signed out, no models,
 * unsupported version, or degraded. The provider's own message follows the
 * title; a clipped one opens in the notice's details popover.
 */
export function providerStatusBannerItem({
  onDismiss,
  onOpenProviderSetup,
  onOpenTerminal,
  status,
}: {
  onDismiss: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  /** Offered for a signed-out provider whose sign-in runs in its CLI. */
  onOpenTerminal?: () => void;
  status: ServerProvider | null;
}): ComposerBannerStackItem | null {
  const bannerKey = getProviderStatusBannerKey(status);
  if (!status || bannerKey === null) {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const incompatible = getIncompatibleVersion(status);
  const hasNoModels =
    status.status === "warning" &&
    status.installed &&
    status.auth.status !== "unauthenticated" &&
    status.models.length === 0;
  const title = isUnauthenticated
    ? `${providerName} signed out`
    : incompatible
      ? `${providerName} ${status.version ?? ""} is ${incompatible.status === "broken" ? "known to be broken" : "unsupported"}`
      : hasNoModels
        ? `${providerName} has no models`
        : status.status === "error"
          ? `${providerName} unavailable`
          : `${providerName} limited`;
  const message = incompatible?.message ?? getProviderStatusMessage(status);
  const isWarning =
    isUnauthenticated ||
    hasNoModels ||
    (incompatible?.status !== "broken" && (status.status === "warning" || incompatible !== null));
  const openSetup = onOpenProviderSetup && hasProviderSetup(status) ? onOpenProviderSetup : null;
  const { instanceId } = status;

  return {
    id: `provider-status:${bannerKey}`,
    variant: isWarning ? "warning" : "error",
    icon: isUnauthenticated ? (
      <KeyRoundIcon />
    ) : hasNoModels ? (
      <BotOffIcon />
    ) : isWarning ? (
      <TriangleAlertIcon />
    ) : (
      <CircleAlertIcon />
    ),
    title,
    description: message,
    actions: openSetup ? (
      <Button size="xs" variant="secondary" onClick={() => openSetup(instanceId)}>
        Provider setup
      </Button>
    ) : isUnauthenticated && onOpenTerminal ? (
      <Button size="xs" variant="secondary" onClick={onOpenTerminal}>
        Open terminal
      </Button>
    ) : undefined,
    dismissLabel: `Dismiss ${providerName} provider ${status.status}`,
    onDismiss,
  };
}
