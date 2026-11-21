import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { previewTabServerRun } from "@t3tools/shared/preview";

import type { BrowserSettingsReadError, OpenPreviewMutation } from "~/browser/openFileInPreview";
import {
  isBrowserTabSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import { openPreviewSession } from "./openPreviewSession";

export async function addBrowserSurface<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly profileId?: string | undefined;
  readonly duplicateFrom?: PreviewSessionSnapshot;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const source = input.duplicateFrom;
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
    ...(source === undefined
      ? {}
      : {
          ...(source.navStatus._tag === "Idle" ? {} : { url: source.navStatus.url }),
          ...(source.profileId === undefined ? {} : { profileId: source.profileId }),
          ...(source.viewport === undefined ? {} : { viewport: source.viewport }),
          runtime: source.runtime ?? "desktop",
        }),
  });
  return mapAtomCommandResult(result, (snapshot) => {
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
    if (source) {
      const panels = useRightPanelStore.getState();
      const { surfaces } = selectThreadRightPanelState(panels.byThreadKey, input.threadRef);
      const sourceIndex = surfaces.findIndex(
        (surface) => surface.kind === "preview" && surface.resourceId === source.tabId,
      );
      const duplicate = surfaces.find(
        (surface) => surface.kind === "preview" && surface.resourceId === snapshot.tabId,
      );
      if (sourceIndex >= 0 && duplicate) {
        panels.moveSurface(input.threadRef, duplicate.id, sourceIndex + 1);
      }
    }
  });
}

const REOPEN_TIMEOUT_MS = 15_000;

class ReopenBrowserTimeoutError extends Schema.TaggedError<ReopenBrowserTimeoutError>()(
  "ReopenBrowserTimeoutError",
  {},
) {
  override get message(): string {
    return "The browser tab took too long to reopen.";
  }
}

const reopening = new Map<string, Promise<AtomCommandResult<PreviewSessionSnapshot, unknown>>>();

/** Reopening preserves the surface descriptor. Two clients reopening one lost browser tab can still
 * create duplicate runtime tabs. */
export function reopenBrowserSurface<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly url?: string | undefined;
}): Promise<AtomCommandResult<PreviewSessionSnapshot, unknown>> {
  const key = `${scopedThreadKey(input.threadRef)}|${input.tabId}`;
  const pending = reopening.get(key);
  if (pending) return pending;
  const url =
    input.url ??
    selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      input.threadRef,
    ).surfaces.find((surface) => isBrowserTabSurface(surface, input.tabId))?.url;
  const store = useRightPanelStore.getState();
  store.beginBrowserReopen(input.threadRef);
  const opened = openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    ...(url === undefined ? {} : { url }),
    // A server tab reopens in the server's browser, wherever this client would open a new one.
    ...(previewTabServerRun(input.tabId) === null ? {} : { runtime: "server" as const }),
  }).then((result) => {
    // A late success still takes the old surface's place.
    if (result._tag === "Success") {
      store.replaceBrowserSurface(input.threadRef, input.tabId, result.value.tabId, url);
    }
    return result;
  });
  // An open that never settles must not hold back the thread's new tabs.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<AtomCommandResult<PreviewSessionSnapshot, unknown>>((resolve) => {
    timer = setTimeout(
      () => resolve(AsyncResult.failure(Cause.fail(new ReopenBrowserTimeoutError()))),
      REOPEN_TIMEOUT_MS,
    );
  });
  const result = Promise.race([opened, timedOut]).finally(() => {
    clearTimeout(timer);
    reopening.delete(key);
    store.endBrowserReopen(input.threadRef);
  });
  reopening.set(key, result);
  return result;
}
