import type { ScopedThreadRef } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";

import {
  browserDefaultOpenProfileId,
  browserDefaultOpenViewport,
  resolveBrowserDefaults,
} from "~/browser/browserDefaults";
import { isWebUrl, resolveBrowserLinkTargetPreference } from "~/browser/browserLinkTarget";
import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import {
  acquirePreviewForward,
  type PreviewForward,
  settleOpenedForward,
} from "~/browser/sshPreviewForwards";
import { recordVisitForThread } from "~/browserHistoryStore";
import { applyPreviewServerSnapshot, isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

const terminalLinkErrorContext = {
  environmentId: Schema.String,
  threadId: Schema.String,
  targetOrigin: Schema.String,
  cause: Schema.Defect(),
};

export class TerminalLinkPreviewOpenError extends Schema.TaggedError<TerminalLinkPreviewOpenError>()(
  "TerminalLinkPreviewOpenError",
  terminalLinkErrorContext,
) {
  override get message(): string {
    return `Failed to open terminal link ${this.targetOrigin} in preview for thread ${this.threadId}.`;
  }
}

interface OpenTerminalLinkInPreviewInput<E> {
  readonly url: string;
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly fallbackToBrowser: () => void;
  /** Cmd/Ctrl-click bypasses the preference and opens in the system browser. */
  readonly forceBrowser: boolean;
}

/**
 * Opens a terminal hyperlink where the "Open links in" setting says, unless a
 * Cmd/Ctrl-click explicitly requests the system browser.
 */
export async function openTerminalLinkInPreview<E>(
  input: OpenTerminalLinkInPreviewInput<E>,
): Promise<void> {
  const supportsPreview =
    !input.forceBrowser &&
    isWebUrl(input.url) &&
    isPreviewSupportedInRuntime() &&
    input.threadRef.threadId.length > 0 &&
    (await resolveBrowserLinkTargetPreference()) === "app";

  if (!supportsPreview) {
    input.fallbackToBrowser();
    return;
  }

  const errorContext = {
    environmentId: input.threadRef.environmentId,
    threadId: input.threadRef.threadId,
    targetOrigin: new URL(input.url).origin,
  };

  const defaults = await resolveBrowserDefaults();
  let forward: PreviewForward;
  try {
    forward = await acquirePreviewForward(input.threadRef.environmentId, input.url);
  } catch (cause) {
    console.error(new TerminalLinkPreviewOpenError({ ...errorContext, cause }));
    input.fallbackToBrowser();
    return;
  }
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: {
      threadId: input.threadRef.threadId,
      url: forward.url,
      // Same reason as `openUrlInPreview`: this path handles its own result
      // mapping, so the configured defaults are applied explicitly.
      viewport: browserDefaultOpenViewport(defaults),
      profileId: browserDefaultOpenProfileId(defaults),
    },
  });
  if (result._tag === "Failure") {
    settleOpenedForward(input.threadRef, forward, null);
    if (isAtomCommandInterrupted(result)) {
      return;
    }
    console.error(
      new TerminalLinkPreviewOpenError({
        ...errorContext,
        cause: result.cause,
      }),
    );
    input.fallbackToBrowser();
    return;
  }
  recordVisitForThread(input.threadRef, input.url);
  applyPreviewServerSnapshot(input.threadRef, result.value);
  settleOpenedForward(input.threadRef, forward, result.value.tabId);
  useRightPanelStore.getState().openBrowser(input.threadRef, result.value.tabId);
}
