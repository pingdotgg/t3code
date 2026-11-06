import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { memo, useRef, useState } from "react";
import { InfoIcon, XIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button, InlineButton } from "../ui/button";
import type { TranslateFn } from "@t3tools/client-runtime/i18n";
import { formatProviderDriverKindLabel } from "../../providerModels";

const providerStatusEnglish = {
  "chat.provider.install": "Open provider setup to install {provider} on this environment.",
  "chat.provider.signInGoogle": "Open provider setup to sign in with Google.",
  "chat.provider.signIn": "Open provider setup to sign in.",
  "chat.provider.signInCli": "Sign in via the CLI to authenticate again.",
  "chat.provider.noModels": "No models are available for this provider.",
  "chat.provider.unavailable": "{provider} provider is unavailable.",
  "chat.provider.limited": "{provider} provider has limited availability.",
} as const;

function providerStatusText(
  t: TranslateFn | undefined,
  key: keyof typeof providerStatusEnglish,
  values?: Record<string, string | number>,
) {
  if (t) return t(key, values);
  return providerStatusEnglish[key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(values?.[name] ?? ""),
  );
}
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RefreshIcon } from "../ui/refresh-icon";
import { useT } from "../../hooks/useI18n";

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

export function getProviderStatusMessage(status: ServerProvider, t?: TranslateFn): string {
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
    return providerStatusText(t, "chat.provider.install", {
      provider: formatProviderDriverKindLabel(status.driver),
    });
  }
  if (status.auth.status === "unauthenticated") {
    if (hasProviderSetup(status)) {
      return status.driver === "antigravity"
        ? providerStatusText(t, "chat.provider.signInGoogle")
        : providerStatusText(t, "chat.provider.signIn");
    }
    return providerStatusText(t, "chat.provider.signInCli");
  }
  return status.status === "ready"
    ? providerStatusText(t, "chat.provider.noModels")
    : status.status === "error"
      ? providerStatusText(t, "chat.provider.unavailable", { provider: providerName })
      : providerStatusText(t, "chat.provider.limited", { provider: providerName });
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  environmentId,
  onDismiss,
  onOpenProviderSetup,
  status,
}: {
  environmentId: EnvironmentId;
  onDismiss: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  status: ServerProvider | null;
}) {
  const t = useT();
  const canRefresh = useAtomValue(serverEnvironment.refreshProviders.permissionAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    label: t("settings.providers.panel.refreshStatus"),
  });
  const refreshingRef = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = async () => {
    if (!status || !canRefresh || refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    await refreshProviders({
      environmentId,
      input: { instanceId: status.instanceId, refreshModels: true },
    });
    refreshingRef.current = false;
    setIsRefreshing(false);
  };

  if (!status || getProviderStatusBannerKey(status) === null) {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const incompatible = getIncompatibleVersion(status);
  const title = isUnauthenticated
    ? t("chat.provider.unauthenticated", { provider: providerName })
    : incompatible
      ? t(incompatible.status === "broken" ? "chat.provider.broken" : "chat.provider.unsupported", {
          provider: providerName,
          version: status.version ?? "",
        })
      : t("chat.provider.status", { provider: providerName });
  const message = incompatible?.message ?? getProviderStatusMessage(status, t);
  const isWarning =
    incompatible?.status !== "broken" && (status.status === "warning" || incompatible !== null);

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <Alert
        variant={isWarning ? "warning" : "error"}
        role={incompatible && incompatible.status !== "broken" ? "status" : "alert"}
        surface="glass"
        controlAlignment="first-line"
      >
        <InfoIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          <div className="flex flex-col gap-2">
            <Tooltip>
              <TooltipTrigger render={<div className="line-clamp-3" />}>{message}</TooltipTrigger>
              <TooltipPopup side="top" className="whitespace-pre-wrap">
                {message}
              </TooltipPopup>
            </Tooltip>
            <div className="flex flex-wrap items-center justify-end gap-3">
              {onOpenProviderSetup && hasProviderSetup(status) ? (
                <InlineButton onClick={() => onOpenProviderSetup(status.instanceId)}>
                  Open provider setup
                </InlineButton>
              ) : null}
              <Button
                aria-label={`Refresh ${providerName} provider status`}
                disabled={!canRefresh || isRefreshing}
                onClick={() => void refresh()}
                size="xs"
                variant="outline"
              >
                <RefreshIcon />
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </Button>
            </div>
          </div>
        </AlertDescription>
        <AlertAction>
          <Button
            aria-label={t("chat.provider.dismiss", {
              provider: providerName,
              status: status.status,
            })}
            onClick={onDismiss}
            size="icon-xs"
            variant="ghost-muted"
          >
            <XIcon />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
});
