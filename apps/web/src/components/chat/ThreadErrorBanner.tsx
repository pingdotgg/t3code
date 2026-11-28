import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_ADMIN_REQUEST,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import { msg } from "gt-react";
import { CircleAlertIcon } from "lucide-react";
import { m, type MessageResolver } from "../../i18n/messages";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function copyAdminRequest() {
  void writeTextToClipboard(CHATGPT_WORKSPACE_ADMIN_REQUEST, {
    target: "admin request",
    unavailableMessage: msg("Clipboard API is unavailable while copying admin request."),
    failureMessage: msg("Failed to copy admin request to the clipboard."),
  }).then(
    () =>
      toastManager.add({
        type: "success",
        title: m(msg("Request copied")),
        description: m(msg("Send it to your workspace admin.")),
      }),
    () => toastManager.add({ type: "error", title: m(msg("Could not copy the request")) }),
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

export function getThreadErrorBannerKey(
  threadKey: string,
  error: string | null,
  source: string | null = null,
): string | null {
  return error === null ? null : `${threadKey}\u0000${source ?? ""}\u0000${error}`;
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
export function threadErrorBannerItem(
  {
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
  },
  resolve: MessageResolver = m,
): ComposerBannerStackItem | null {
  if (!error) return null;
  const message = getThreadErrorBannerMessage(error);
  const workspaceLimit = errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || errorCode === CHATGPT_USAGE_LIMIT_CODE;
  return {
    // Only a server runtime error has a session dismissal key; a local one is cleared instead.
    id: `thread-error:${bannerKey ?? error}`,
    variant: errorClass === "usage_limit" || chatGptLimit ? "warning" : "error",
    icon: chatGptLimit ? <OpenAI aria-hidden="true" /> : <CircleAlertIcon />,
    title: chatGptLimit ? resolve(msg("ChatGPT usage limit reached")) : resolve(msg("Run failed")),
    description: workspaceLimit
      ? resolve(
          msg(
            "You've reached your workspace's limit for using your ChatGPT plan in other apps. Copy a request to ask your workspace admin for increased usage limits.",
          ),
        )
      : chatGptLimit
        ? null
        : message,
    descriptionDetails:
      !chatGptLimit && message !== error ? (
        <span className="whitespace-pre-wrap">{error}</span>
      ) : undefined,
    actions: workspaceLimit ? (
      <Button variant="ghost-muted" size="xs" onClick={copyAdminRequest}>
        {resolve(msg("Copy request for admin"))}
      </Button>
    ) : chatGptLimit ? (
      <ChatGptUsageButton variant="ghost-muted" size="xs" />
    ) : onRetry ? (
      <Button size="xs" variant="ghost-muted" disabled={retrying} onClick={onRetry}>
        {retrying ? resolve(msg("Retrying...")) : resolve(msg("Retry"))}
      </Button>
    ) : undefined,
    dismissLabel: resolve(msg("Dismiss error")),
    ...(onDismiss ? { onDismiss } : {}),
  };
}
