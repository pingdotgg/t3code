import { memo, useRef } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CheckIcon, CircleAlertIcon, CopyIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { anchoredToastManager } from "../ui/toast";

const COPY_FEEDBACK_TIMEOUT_MS = 1000;

export function showThreadErrorCopyFailure(
  anchor: HTMLButtonElement | null,
  copyError: Error,
): void {
  if (!anchor) return;
  anchoredToastManager.add({
    data: { tooltipStyle: true },
    positionerProps: { anchor },
    timeout: COPY_FEEDBACK_TIMEOUT_MS,
    title: "Failed to copy",
    description: copyError.message,
  });
}

function ThreadErrorCopyButton({ error }: { error: string }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "error-message",
    timeout: COPY_FEEDBACK_TIMEOUT_MS,
    onError: (copyError) => showThreadErrorCopyFailure(buttonRef.current, copyError),
  });
  const copyLabel = isCopied ? "Copied error" : "Copy error";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={copyLabel}
            onClick={() => copyToClipboard(error)}
            ref={buttonRef}
            type="button"
          />
        }
      >
        {isCopied ? <CheckIcon className="text-success!" /> : <CopyIcon className="text-error" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{copyLabel}</TooltipPopup>
    </Tooltip>
  );
}

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
    <div className="mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant="error" controlAlignment="first-line">
        <CircleAlertIcon />
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>{error}</TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {error}
            </TooltipPopup>
          </Tooltip>
        </AlertDescription>
        <AlertAction>
          <ThreadErrorCopyButton error={error} />
          {onDismiss && (
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
              <XIcon className="text-destructive" />
            </Button>
          )}
        </AlertAction>
      </Alert>
    </div>
  );
});
