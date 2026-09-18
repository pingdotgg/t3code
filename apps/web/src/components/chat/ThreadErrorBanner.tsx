import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, ClockIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usePrimarySettings } from "../../hooks/useSettings";
import { formatUpcomingTimestamp } from "../../timestampFormat";

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

/**
 * Limit-reset continuation the banner can offer beside a usage-limit error.
 * `resetsAt` is the provider-reported reset instant; `scheduledFor` is the
 * thread's pending schedule, when one exists.
 */
export interface ThreadErrorBannerAutoContinue {
  readonly resetsAt: string;
  readonly scheduledFor: string | null;
  readonly onSchedule: () => void;
  readonly onCancel: () => void;
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  autoContinue,
}: {
  error: string | null;
  onDismiss?: () => void;
  autoContinue?: ThreadErrorBannerAutoContinue | null;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const scheduledFor = autoContinue?.scheduledFor ?? null;
  // A pending continuation stays visible after the error text is dismissed:
  // a scheduled turn the user could neither see nor cancel is a one-way door.
  if (!error && scheduledFor === null) return null;
  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert
        variant={error ? "error" : "info"}
        controlAlignment="first-line"
        className="alert-glass"
        data-variant={error ? "error" : "info"}
      >
        {error ? <CircleAlertIcon /> : <ClockIcon />}
        <AlertDescription>
          {error ? (
            <Tooltip>
              <TooltipTrigger render={<div className="line-clamp-3" />}>{error}</TooltipTrigger>
              <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
                {error}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {autoContinue ? (
            <div className={`flex flex-wrap items-center gap-2${error ? " mt-1.5" : ""}`}>
              {scheduledFor !== null ? (
                <>
                  <span>
                    Continuing when the limit resets ·{" "}
                    {formatUpcomingTimestamp(scheduledFor, timestampFormat)}
                  </span>
                  <Button variant="ghost" size="compact" onClick={autoContinue.onCancel}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button variant="outline" size="compact" onClick={autoContinue.onSchedule}>
                  Continue when limit resets ·{" "}
                  {formatUpcomingTimestamp(autoContinue.resetsAt, timestampFormat)}
                </Button>
              )}
            </div>
          ) : null}
        </AlertDescription>
        {error && onDismiss ? (
          <AlertAction>
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
              <XIcon className="text-destructive" />
            </Button>
          </AlertAction>
        ) : null}
      </Alert>
    </div>
  );
});
