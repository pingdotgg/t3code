import { type ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { InfoIcon, XIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button, InlineButton } from "../ui/button";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function getProviderStatusBannerKey(status: ServerProvider | null): string | null {
  if (!status || status.status === "ready" || status.status === "disabled") return null;
  // Antigravity checks saved credentials when a session starts. Its local
  // health check leaves auth unknown after a restart, which is not a failure.
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

/** Keep the environment's error intact in both the banner and model picker. */
export function getProviderStatusMessage(status: ServerProvider): string {
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

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  onDismiss,
  onOpenProviderSetup,
  status,
}: {
  onDismiss: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  status: ServerProvider | null;
}) {
  if (!status || getProviderStatusBannerKey(status) === null) {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const title = isUnauthenticated
    ? `${providerName} is unauthenticated`
    : `${providerName} provider status`;
  const message = getProviderStatusMessage(status);

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <Alert
        variant={status.status === "warning" ? "warning" : "error"}
        surface="glass"
        controlAlignment="first-line"
      >
        <InfoIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>{message}</TooltipTrigger>
            <TooltipPopup side="top" className="whitespace-pre-wrap">
              {message}
            </TooltipPopup>
          </Tooltip>
          {onOpenProviderSetup && hasProviderSetup(status) ? (
            <InlineButton onClick={() => onOpenProviderSetup(status.instanceId)}>
              Open provider setup
            </InlineButton>
          ) : null}
        </AlertDescription>
        <AlertAction>
          <Button
            aria-label={`Dismiss ${providerName} provider ${status.status}`}
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
