import { useAtomValue } from "@effect/atom-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RefreshIcon } from "../ui/refresh-icon";
import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { msg, T, useGT } from "gt-react";
import { BotOffIcon, CircleAlertIcon, KeyRoundIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "../ui/button";
import { m, type MessageResolver } from "../../i18n/messages";
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
  isDismissed: boolean,
): boolean {
  return getProviderStatusBannerKey(status) !== null && !isDismissed;
}

// Built-in instance ids such as `codex` repeat across environments.
export function getProviderStatusDismissalKey(
  environmentId: string | undefined,
  status: ServerProvider | null,
): string | null {
  const bannerKey = getProviderStatusBannerKey(status);
  return bannerKey === null ? null : `${environmentId ?? ""}\u0000${bannerKey}`;
}

// A dismissal lasts the session, not one view, so opening another thread cannot bring it back.
const sessionDismissedProviderStatusBannerKeys = new Set<string>();
const dismissalListeners = new Set<() => void>();

export function dismissProviderStatusBannerForSession(bannerKey: string | null): void {
  if (bannerKey === null || sessionDismissedProviderStatusBannerKeys.has(bannerKey)) return;
  sessionDismissedProviderStatusBannerKeys.add(bannerKey);
  for (const listener of dismissalListeners) listener();
}

export function isProviderStatusBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedProviderStatusBannerKeys.has(bannerKey);
}

function subscribeToDismissals(listener: () => void) {
  dismissalListeners.add(listener);
  return () => dismissalListeners.delete(listener);
}

export function useProviderStatusBannerDismissed(bannerKey: string | null): boolean {
  return useSyncExternalStore(subscribeToDismissals, () =>
    isProviderStatusBannerDismissedForSession(bannerKey),
  );
}

export function hasProviderSetup(status: ServerProvider): boolean {
  return (
    status.driver === "antigravity" ||
    status.setup?.canAuthenticate === true ||
    status.setup?.canInstall === true
  );
}

/** Components pass `useMessages()` so the message follows a language switch. */
export function getProviderStatusMessage(
  status: ServerProvider,
  resolve: MessageResolver = m,
): string {
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
    return resolve(
      msg("Open provider setup to install {provider} on this environment.", {
        provider: formatProviderDriverKindLabel(status.driver),
      }),
    );
  }
  if (status.auth.status === "unauthenticated") {
    if (hasProviderSetup(status)) {
      return status.driver === "antigravity"
        ? resolve(msg("Open provider setup to sign in with Google."))
        : resolve(msg("Open provider setup to sign in."));
    }
    return resolve(msg("Sign in via the CLI to authenticate again."));
  }
  return status.status === "ready"
    ? resolve(msg("No models are available for this provider."))
    : status.status === "error"
      ? resolve(msg("{provider} provider is unavailable.", { provider: providerName }))
      : resolve(msg("{provider} provider has limited availability.", { provider: providerName }));
}

/**
 * The selected provider's status as a tray notice: signed out, no models,
 * unsupported version, or degraded. The provider's own message follows the
 * title; a clipped one opens in the notice's details popover.
 */
export function providerStatusBannerItem({
  environmentId,
  onDismiss,
  onOpenProviderSetup,
  onOpenTerminal,
  status,
  resolve = m,
}: {
  environmentId: EnvironmentId;
  onDismiss: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  /** Offered for a signed-out provider whose sign-in runs in its CLI. */
  onOpenTerminal?: () => void;
  status: ServerProvider | null;
  resolve?: MessageResolver;
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
    ? resolve(msg("{provider} signed out", { provider: providerName }))
    : incompatible
      ? incompatible.status === "broken"
        ? resolve(
            msg("{provider} {version} is known to be broken", {
              provider: providerName,
              version: status.version ?? "",
            }),
          )
        : resolve(
            msg("{provider} {version} is unsupported", {
              provider: providerName,
              version: status.version ?? "",
            }),
          )
      : hasNoModels
        ? resolve(msg("{provider} has no models", { provider: providerName }))
        : status.status === "error"
          ? resolve(msg("{provider} unavailable", { provider: providerName }))
          : resolve(msg("{provider} limited", { provider: providerName }));
  const message = incompatible?.message ?? getProviderStatusMessage(status, resolve);
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
    actions: (
      <>
        {openSetup ? (
          <Button size="xs" variant="ghost-muted" onClick={() => openSetup(instanceId)}>
            <T>Provider setup</T>
          </Button>
        ) : isUnauthenticated && onOpenTerminal ? (
          <Button size="xs" variant="ghost-muted" onClick={onOpenTerminal}>
            <T>Open terminal</T>
          </Button>
        ) : null}
        <ProviderStatusRefreshButton
          key={`${environmentId}:${instanceId}`}
          environmentId={environmentId}
          instanceId={instanceId}
          providerName={providerName}
        />
      </>
    ),
    dismissLabel:
      status.status === "error"
        ? resolve(msg("Dismiss {provider} provider error", { provider: providerName }))
        : status.status === "warning"
          ? resolve(msg("Dismiss {provider} provider warning", { provider: providerName }))
          : status.status === "ready"
            ? resolve(msg("Dismiss {provider} provider ready", { provider: providerName }))
            : resolve(msg("Dismiss {provider} provider disabled", { provider: providerName })),
    onDismiss,
  };
}

function ProviderStatusRefreshButton({
  environmentId,
  instanceId,
  providerName,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  providerName: string;
}) {
  const gt = useGT();
  const canRefresh = useAtomValue(serverEnvironment.refreshProviders.permissionAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    label: "Refresh provider status",
  });
  const refreshingRef = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refresh = async () => {
    if (!canRefresh || refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    await refreshProviders({ environmentId, input: { instanceId, refreshModels: true } });
    refreshingRef.current = false;
    setIsRefreshing(false);
  };
  return (
    <Button
      aria-label={gt("Refresh {provider} provider status", { provider: providerName })}
      disabled={!canRefresh || isRefreshing}
      onClick={() => void refresh()}
      size="xs"
      variant="ghost-muted"
    >
      <RefreshIcon />
      {isRefreshing ? gt("Refreshing...") : gt("Refresh")}
    </Button>
  );
}
