import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, KeyRoundIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  onReauthenticate,
  reauthenticateLabel,
}: {
  error: string | null;
  onDismiss?: () => void;
  /**
   * When provided, renders a "Re-authenticate" action alongside the error.
   * The caller decides when to offer it — typically when the error looks like
   * an expired/failed provider credential and the active provider advertises
   * an in-app re-authentication command.
   */
  onReauthenticate?: () => void;
  reauthenticateLabel?: string;
}) {
  if (!error) return null;
  return (
    <div className="mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>{error}</TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {error}
            </TooltipPopup>
          </Tooltip>
        </AlertDescription>
        {(onReauthenticate || onDismiss) && (
          <AlertAction>
            {onReauthenticate && (
              <Button variant="outline" size="sm" onClick={onReauthenticate}>
                <KeyRoundIcon className="size-3.5" aria-hidden />
                {reauthenticateLabel ?? "Re-authenticate"}
              </Button>
            )}
            {onDismiss && (
              <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
                <XIcon className="text-destructive" />
              </Button>
            )}
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
