import { type ServerProvider, type ServerProviderReauthentication } from "@t3tools/contracts";
import { memo } from "react";
import { InfoIcon, KeyRoundIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
  onReauthenticate,
}: {
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
    <div className="mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <div
        className={cn(
          "inline-flex items-center gap-3 rounded-xl border px-3.5 py-3 text-card-foreground text-sm",
          status.status === "warning"
            ? "border-warning/32 bg-warning/4 [&_svg]:text-warning"
            : "border-destructive/32 bg-destructive/4 text-destructive-foreground [&_svg]:text-destructive",
        )}
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
      </div>
    </div>
  );
});
