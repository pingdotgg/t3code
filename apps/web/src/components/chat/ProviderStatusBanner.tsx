import { type EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { InfoIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { ProviderSignInAction } from "../settings/ProviderSignInDialog"; // fork: f1 provider account sign-in
import { supportsInAppSignIn } from "../settings/providerSignInFlows"; // fork: f1 provider account sign-in
import { providerQuotaNotice } from "../settings/providerQuotaPresentation"; // fork: f1 account quota
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
  // fork: f1 — the environment whose serverConfig produced `status`. Sign-in
  // and sign-out must target it, not the primary environment.
  environmentId = null,
}: {
  onDismiss: () => void;
  status: ServerProvider | null;
  environmentId?: EnvironmentId | null;
}) {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const title = isUnauthenticated
    ? `${providerName} is unauthenticated`
    : `${providerName} provider status`;
  // fork: f1 — when the driver can drive a login in-app, say so instead of
  // sending the user to a terminal. Falls back to the upstream copy otherwise.
  const canSignInHere = supportsInAppSignIn(status);
  // fork: f1 increment 2 — the banner only ever renders for a non-ready
  // provider, so a quota line here is additional context, never new chrome.
  const quotaNotice = providerQuotaNotice(status.auth, Date.now());
  const message = isUnauthenticated
    ? canSignInHere
      ? "Sign in to authenticate again."
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
          {/* fork: f1 increment 2 — one quota line, only when the account is
              actually out of quota or about to lose its credential. */}
          {quotaNotice ? <div className="text-muted-foreground">{quotaNotice}</div> : null}
          {/* fork: f1 provider account sign-in */}
          {isUnauthenticated ? (
            <ProviderSignInAction provider={status} environmentId={environmentId} />
          ) : null}
        </div>
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
