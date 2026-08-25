import { type ServerProvider, type ServerProviderReauthentication } from "@t3tools/contracts";
import { memo } from "react";
import { InfoIcon, KeyRoundIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function getProviderStatusBannerKey(status: ServerProvider | null): string | null {
  return !status || status.status === "ready" || status.status === "disabled"
    ? null
    : [status.instanceId, status.status, status.auth.status, status.message ?? ""].join("\u0000");
}

export function shouldShowProviderStatusBanner(
  status: ServerProvider | null,
  dismissedBannerKey: string | null,
): boolean {
  const bannerKey = getProviderStatusBannerKey(status);
  return bannerKey !== null && bannerKey !== dismissedBannerKey;
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  onDismiss,
  status,
  onReauthenticate,
}: {
  onDismiss: () => void;
  status: ServerProvider | null;
  /**
   * Invoked when the user clicks the in-app "Re-authenticate" action. Only
   * offered when the provider is unauthenticated and advertised a
   * `reauthentication` descriptor. Runs the login command inside the thread's
   * integrated terminal.
   */
  onReauthenticate?: (reauthentication: ServerProviderReauthentication) => void;
}) {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const reauthentication = status.reauthentication ?? null;
  const canReauthenticate =
    isUnauthenticated && Boolean(reauthentication) && Boolean(onReauthenticate);
  const title = isUnauthenticated
    ? `${providerName} is unauthenticated`
    : `${providerName} provider status`;
  const message = isUnauthenticated
    ? canReauthenticate
      ? "Re-authenticate to keep using this provider."
      : "Sign in via the CLI to authenticate again."
    : (status.message ??
      (status.status === "error"
        ? `${providerName} provider is unavailable.`
        : `${providerName} provider has limited availability.`));

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <div
        className={cn(
          "alert-glass relative inline-flex items-center gap-3 rounded-xl border py-3 ps-3.5 pe-10 text-card-foreground text-sm",
          status.status === "warning"
            ? "border-warning/32 [&_svg]:text-warning"
            : "border-destructive/32 text-destructive-foreground [&_svg]:text-destructive",
        )}
        data-variant={status.status === "warning" ? "warning" : "error"}
        role="alert"
      >
        <InfoIcon className="size-4 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="font-medium">{title}</div>
          <Tooltip>
            <TooltipTrigger
              render={<div className="line-clamp-3 text-muted-foreground">{message}</div>}
            />
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {message}
            </TooltipPopup>
          </Tooltip>
        </div>
        {canReauthenticate && reauthentication ? (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => onReauthenticate?.(reauthentication)}
          >
            <KeyRoundIcon className="size-3.5" aria-hidden />
            {reauthentication.label ?? "Re-authenticate"}
          </Button>
        ) : null}
        <Button
          aria-label={`Dismiss ${providerName} provider ${status.status}`}
          className="absolute top-2 right-2 size-6 text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
    </div>
  );
});
