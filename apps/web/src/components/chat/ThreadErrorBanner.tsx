import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function getThreadErrorBannerKey(threadKey: string, error: string | null): string | null {
  return error === null ? null : `${threadKey}\u0000${error}`;
}

export function shouldShowThreadErrorBanner(
  threadKey: string,
  error: string | null,
  isDismissed: boolean,
): boolean {
  return getThreadErrorBannerKey(threadKey, error) !== null && !isDismissed;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes between threads). Mirrors the branch-mismatch banner: a dismissal
// is remembered per thread key plus message, so navigating away to a thread
// with no error cannot resurrect the banner, while a different error message
// on the same thread still appears.
const sessionDismissedThreadErrorBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey !== null) {
    sessionDismissedThreadErrorBannerKeys.add(bannerKey);
  }
}

export function isThreadErrorBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedThreadErrorBannerKeys.has(bannerKey);
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert
        variant="error"
        controlAlignment="first-line"
        className="alert-glass"
        data-variant="error"
      >
        <CircleAlertIcon />
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>{error}</TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {error}
            </TooltipPopup>
          </Tooltip>
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
              <XIcon className="text-destructive" />
            </Button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
