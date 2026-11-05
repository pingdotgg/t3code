import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_ADMIN_REQUEST,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import { memo, useRef } from "react";
import { useCopyToClipboard, writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { anchoredToastManager, toastManager } from "../ui/toast";
import { CheckIcon, CircleAlertIcon, CopyIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { ExpandableText } from "../settings/ExpandableText";

const COPY_FEEDBACK_TIMEOUT_MS = 1000;

export function formatThreadErrorClipboardText(input: {
  readonly error: string;
  readonly title?: string | null;
  readonly provider?: string | null;
  readonly threadId?: string | null;
}): string {
  const header: string[] = [];
  const title = input.title?.trim();
  const provider = input.provider?.trim();
  const threadId = input.threadId?.trim();
  if (title) header.push(`Thread: ${title}`);
  if (provider) header.push(`Provider: ${provider}`);
  if (threadId) header.push(`Thread ID: ${threadId}`);
  return header.length === 0 ? input.error : `${header.join("\n")}\n\n${input.error}`;
}

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

function ThreadErrorCopyButton({ clipboardText }: { clipboardText: string }) {
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
            onClick={() => copyToClipboard(clipboardText)}
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

export function copyAdminRequest() {
  void writeTextToClipboard(CHATGPT_WORKSPACE_ADMIN_REQUEST, "admin request").then(
    () =>
      toastManager.add({
        type: "success",
        title: "Request copied",
        description: "Send it to your workspace admin.",
      }),
    () => toastManager.add({ type: "error", title: "Could not copy the request" }),
  );
}

export function getThreadErrorBannerMessage(error: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(error);
  } catch {
    return error;
  }
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return error;
  }
  const nestedError = payload.error;
  if (typeof nestedError !== "object" || nestedError === null || !("message" in nestedError)) {
    return error;
  }
  return typeof nestedError.message === "string" && nestedError.message.trim().length > 0
    ? nestedError.message
    : error;
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
  copyContext,
  onDismiss,
  errorClass,
  errorCode,
}: {
  error: string | null;
  copyContext?: {
    readonly title?: string | null;
    readonly provider?: string | null;
    readonly threadId?: string | null;
  };
  errorClass?: OrchestrationV2ProviderFailureClass | null;
  errorCode?: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  const workspaceLimit = errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || errorCode === CHATGPT_USAGE_LIMIT_CODE;
  const variant = errorClass === "usage_limit" || chatGptLimit ? "warning" : "error";
  const clipboardText = formatThreadErrorClipboardText({ error, ...copyContext });
  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant={variant} surface="glass" controlAlignment="first-line" data-variant={variant}>
        {chatGptLimit ? (
          <OpenAI className="size-4 text-foreground!" aria-hidden="true" />
        ) : (
          <CircleAlertIcon />
        )}
        <AlertDescription>
          {chatGptLimit ? (
            <div className="space-y-1">
              <p className="font-medium">ChatGPT usage limit reached</p>
              {workspaceLimit ? (
                <p>
                  {
                    "You've reached your workspace's limit for using your ChatGPT plan in other apps. Copy a request to ask your workspace admin for increased usage limits."
                  }
                </p>
              ) : null}
            </div>
          ) : (
            <ExpandableText text={error} collapsedText={getThreadErrorBannerMessage(error)} />
          )}
        </AlertDescription>
        <AlertAction>
          {workspaceLimit ? (
            <Button variant="default" size="sm" onClick={copyAdminRequest}>
              Copy request for admin
            </Button>
          ) : chatGptLimit ? (
            <ChatGptUsageButton variant="default" size="sm" />
          ) : null}
          <ThreadErrorCopyButton clipboardText={clipboardText} />
          {onDismiss ? (
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
              <XIcon />
            </Button>
          ) : null}
        </AlertAction>
      </Alert>
    </div>
  );
});
