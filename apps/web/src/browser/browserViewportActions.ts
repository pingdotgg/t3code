import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PreviewViewportSetting, ScopedThreadRef } from "@t3tools/contracts";

import { toastManager } from "~/components/ui/toast";
import { updatePreviewServerSnapshot } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";

/** One browser tab as both the server (thread + tab id) and this window's runtime know it. */
export interface BrowserViewportTarget {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
}

export const BROWSER_VIEWPORT_COMMIT_TIMEOUT_MS = 15_000;

class BrowserViewportCommitTimeoutError extends Error {
  override readonly name = "BrowserViewportCommitTimeoutError";

  constructor(readonly tabId: string) {
    super(`Timed out committing the browser viewport for tab ${tabId}`);
  }
}

const commitTails = new Map<string, Promise<void>>();

const queueBrowserViewportMutation = <A>(
  tabId: string,
  start: () => Promise<A>,
): {
  readonly started: Promise<{ readonly operation: Promise<A> }>;
  readonly execution: Promise<A>;
} => {
  const previous = commitTails.get(tabId) ?? Promise.resolve();
  const started = previous
    .catch(() => undefined)
    .then(() => ({
      operation: Promise.resolve().then(start),
    }));
  const execution = started.then(({ operation }) => operation);
  const tail = execution.then(() => undefined);
  commitTails.set(tabId, tail);
  const clear = () => {
    if (commitTails.get(tabId) === tail) commitTails.delete(tabId);
  };
  void tail.then(clear, clear);
  return { started, execution };
};

/** Serializes UI and automation mutations per tab so rollback cannot overtake a newer resize. */
export function runBrowserViewportMutation<A>(
  tabId: string,
  mutation: () => Promise<A>,
): Promise<A> {
  return queueBrowserViewportMutation(tabId, mutation).execution;
}

const runHandlerWithTimeout = (tabId: string, operation: Promise<void>): Promise<void> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new BrowserViewportCommitTimeoutError(tabId)),
      BROWSER_VIEWPORT_COMMIT_TIMEOUT_MS,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
};

async function resizeBrowserViewport(
  target: BrowserViewportTarget,
  viewport: PreviewViewportSetting,
): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    previewEnvironment.resize,
    {
      environmentId: target.threadRef.environmentId,
      input: { threadId: target.threadRef.threadId, tabId: target.tabId, viewport },
    },
    { label: "preview viewport resize" },
  );
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Unable to resize browser viewport",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
    throw error;
  }
  updatePreviewServerSnapshot(target.threadRef, result.value);
}

/**
 * Runs `operation` after every earlier commit for the runtime tab. The
 * caller-facing timeout starts only once it reaches the front of the queue,
 * while the queue itself waits for the real operation.
 */
export function queueBrowserViewportCommit(
  runtimeTabId: string,
  operation: () => Promise<void>,
): Promise<void> {
  const { started } = queueBrowserViewportMutation(runtimeTabId, operation);
  return started.then(({ operation: running }) => runHandlerWithTimeout(runtimeTabId, running));
}

export function commitBrowserViewportChange(
  target: BrowserViewportTarget,
  setting: PreviewViewportSetting,
): Promise<void> {
  return queueBrowserViewportCommit(target.runtimeTabId, () =>
    resizeBrowserViewport(target, setting),
  );
}
