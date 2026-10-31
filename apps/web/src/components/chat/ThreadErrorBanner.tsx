import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_ADMIN_REQUEST,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import { CircleAlertIcon } from "lucide-react";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

function copyAdminRequest() {
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

/**
 * The thread's last error as a tray notice. Structured errors show their message;
 * exact diagnostics open in the notice's details popover. Retry sends the failed
 * run's prompt again when the thread can run.
 */
export function threadErrorBannerItem({
  bannerKey,
  error,
  errorClass,
  errorCode,
  onDismiss,
  onRetry,
  retrying = false,
}: {
  bannerKey: string | null;
  error: string | null;
  errorClass?: OrchestrationV2ProviderFailureClass | null;
  errorCode?: string | null;
  onDismiss?: () => void;
  onRetry?: (() => void) | null;
  retrying?: boolean;
}): ComposerBannerStackItem | null {
  if (!error || bannerKey === null) return null;
  const message = getThreadErrorBannerMessage(error);
  const workspaceLimit = errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || errorCode === CHATGPT_USAGE_LIMIT_CODE;
  return {
    id: `thread-error:${bannerKey}`,
    variant: errorClass === "usage_limit" || chatGptLimit ? "warning" : "error",
    icon: chatGptLimit ? <OpenAI aria-hidden="true" /> : <CircleAlertIcon />,
    title: chatGptLimit ? "ChatGPT usage limit reached" : "Run failed",
    description: workspaceLimit
      ? "You've reached your workspace's limit for using your ChatGPT plan in other apps. Copy a request to ask your workspace admin for increased usage limits."
      : chatGptLimit
        ? "Review your usage settings in ChatGPT."
        : message,
    descriptionDetails:
      !chatGptLimit && message !== error ? (
        <span className="whitespace-pre-wrap">{error}</span>
      ) : undefined,
    actions: workspaceLimit ? (
      <Button variant="default" size="xs" onClick={copyAdminRequest}>
        Copy request for admin
      </Button>
    ) : chatGptLimit ? (
      <ChatGptUsageButton variant="secondary" size="xs" />
    ) : onRetry ? (
      <Button size="xs" variant="default" disabled={retrying} onClick={onRetry}>
        {retrying ? "Retrying..." : "Retry"}
      </Button>
    ) : undefined,
    dismissLabel: "Dismiss error",
    ...(onDismiss ? { onDismiss } : {}),
  };
}
