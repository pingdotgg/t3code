import type { ScopedThreadRef } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { isPreviewableUrl } from "@t3tools/shared/preview";
import * as Schema from "effect/Schema";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { applyPreviewServerSnapshot, isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

const terminalLinkErrorContext = {
  environmentId: Schema.String,
  threadId: Schema.String,
  targetOrigin: Schema.String,
  cause: Schema.Defect(),
};

export class TerminalLinkPreviewOpenError extends Schema.TaggedErrorClass<TerminalLinkPreviewOpenError>()(
  "TerminalLinkPreviewOpenError",
  terminalLinkErrorContext,
) {
  override get message(): string {
    return `Failed to open terminal link ${this.targetOrigin} in preview for thread ${this.threadId}.`;
  }
}

export function canOpenTerminalLinkInPreview(
  url: string,
  threadRef: Pick<ScopedThreadRef, "threadId">,
): boolean {
  return isPreviewableUrl(url) && isPreviewSupportedInRuntime() && threadRef.threadId.length > 0;
}

interface OpenTerminalLinkInPreviewInput<E> {
  readonly url: string;
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly fallbackToBrowser: () => void;
}

export async function openTerminalLinkInPreview<E>(
  input: OpenTerminalLinkInPreviewInput<E>,
): Promise<void> {
  if (!canOpenTerminalLinkInPreview(input.url, input.threadRef)) {
    input.fallbackToBrowser();
    return;
  }

  const errorContext = {
    environmentId: input.threadRef.environmentId,
    threadId: input.threadRef.threadId,
    targetOrigin: new URL(input.url).origin,
  };

  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: { threadId: input.threadRef.threadId, url: input.url },
  });
  if (result._tag === "Failure") {
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
  useRightPanelStore.getState().openBrowser(input.threadRef, result.value.tabId);
}
