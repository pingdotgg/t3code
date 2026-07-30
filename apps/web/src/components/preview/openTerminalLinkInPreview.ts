import type { LocalApi, ScopedThreadRef } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { isPreviewableUrl } from "@t3tools/shared/preview";
import * as Schema from "effect/Schema";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { applyPreviewServerSnapshot, isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

const terminalLinkErrorContext = {
  environmentId: Schema.String,
  threadId: Schema.String,
  targetOrigin: Schema.String,
  cause: Schema.Defect(),
};

export class TerminalLinkContextMenuShowError extends Schema.TaggedErrorClass<TerminalLinkContextMenuShowError>()(
  "TerminalLinkContextMenuShowError",
  terminalLinkErrorContext,
) {
  override get message(): string {
    return `Failed to show the context menu for terminal link ${this.targetOrigin}.`;
  }
}

export class TerminalLinkPreviewOpenError extends Schema.TaggedErrorClass<TerminalLinkPreviewOpenError>()(
  "TerminalLinkPreviewOpenError",
  terminalLinkErrorContext,
) {
  override get message(): string {
    return `Failed to open terminal link ${this.targetOrigin} in preview for thread ${this.threadId}.`;
  }
}

interface OpenTerminalLinkInPreviewInput<E> {
  readonly url: string;
  readonly position: { x: number; y: number };
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly localApi: LocalApi;
  readonly fallbackToBrowser: () => void;
}

export async function openTerminalLinkInPreview<E>(
  input: OpenTerminalLinkInPreviewInput<E>,
): Promise<void> {
  const supportsPreview =
    isPreviewableUrl(input.url) &&
    isPreviewSupportedInRuntime() &&
    input.threadRef.threadId.length > 0;

  if (!supportsPreview) {
    input.fallbackToBrowser();
    return;
  }

  const errorContext = {
    environmentId: input.threadRef.environmentId,
    threadId: input.threadRef.threadId,
    targetOrigin: new URL(input.url).origin,
  };

  let choice: "open-in-preview" | "open-in-browser" | null;
  try {
    choice = await input.localApi.contextMenu.show(
      [
        { id: "open-in-preview", label: "Open in preview" },
        { id: "open-in-browser", label: "Open in browser" },
      ],
      input.position,
    );
  } catch (cause) {
    console.error(
      new TerminalLinkContextMenuShowError({
        ...errorContext,
        cause,
      }),
    );
    input.fallbackToBrowser();
    return;
  }

  if (choice === "open-in-preview") {
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
    applyPreviewServerSnapshot(input.threadRef, result.value);
    useRightPanelStore.getState().openBrowser(input.threadRef, result.value.tabId);
    return;
  }

  if (choice === "open-in-browser") {
    input.fallbackToBrowser();
  }
}
