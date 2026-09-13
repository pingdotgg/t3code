import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type {
  BrowserPreviewUnavailableError,
  BrowserSettingsReadError,
  OpenPreviewMutation,
} from "~/browser/openFileInPreview";
import { useRightPanelStore } from "~/rightPanelStore";

import { openPreviewSession } from "./openPreviewSession";

/** Creates a new browser tab. Reopening an existing tab is a separate UI action. */
export async function addBrowserSurface<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly isCurrent?: () => boolean;
  readonly openPreview: OpenPreviewMutation<E>;
  /** Omit to use the configured default profile. */
  readonly profileId?: string | undefined;
  /** Recheck after creation so a later panel choice keeps focus. */
  readonly shouldActivate?: (() => boolean) | undefined;
}): Promise<
  AtomCommandResult<void, E | BrowserSettingsReadError | BrowserPreviewUnavailableError>
> {
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
    threadRef: input.threadRef,
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
  });
  return mapAtomCommandResult(result, (snapshot) => {
    if (input.shouldActivate?.() === false) return;
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}
