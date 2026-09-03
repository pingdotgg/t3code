import type { PreviewViewportSetting } from "@t3tools/contracts";

type BrowserViewportHandler = (setting: PreviewViewportSetting) => Promise<void>;

interface BrowserViewportMutationDeadline {
  readonly deadlineAt: number;
  readonly timeoutError: () => Error;
}

export const BROWSER_VIEWPORT_COMMIT_TIMEOUT_MS = 15_000;

export class BrowserViewportCommitTimeoutError extends Error {
  override readonly name = "BrowserViewportCommitTimeoutError";

  constructor(readonly tabId: string) {
    super(`Timed out committing the browser viewport for tab ${tabId}`);
  }
}

const handlers = new Map<string, BrowserViewportHandler>();
const commitTails = new Map<string, Promise<void>>();

const runOperationBeforeDeadline = <A>(
  operation: Promise<A>,
  deadline: BrowserViewportMutationDeadline,
): Promise<A> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(deadline.timeoutError()),
      Math.max(0, deadline.deadlineAt - Date.now()),
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
};

const queueBrowserViewportMutation = <A>(
  tabId: string,
  start: () => Promise<A>,
  deadline?: BrowserViewportMutationDeadline,
): {
  readonly started: Promise<{ readonly operation: Promise<A> }>;
  readonly execution: Promise<A>;
} => {
  const previous = commitTails.get(tabId) ?? Promise.resolve();
  const started = previous
    .catch(() => undefined)
    .then(() => ({
      operation:
        deadline && Date.now() >= deadline.deadlineAt
          ? Promise.reject<A>(deadline.timeoutError())
          : Promise.resolve().then(start),
    }));
  const operation = started.then(({ operation: startedOperation }) => startedOperation);
  const execution = deadline ? runOperationBeforeDeadline(operation, deadline) : operation;
  // If this mutation reached the front, its deadline releases the queue even
  // when the underlying request never settles. A mutation that expires while
  // waiting still follows the prior tail and cannot overtake it.
  const tail = started
    .then(({ operation: startedOperation }) =>
      deadline ? runOperationBeforeDeadline(startedOperation, deadline) : startedOperation,
    )
    .then(() => undefined);
  commitTails.set(tabId, tail);
  const clear = () => {
    if (commitTails.get(tabId) === tail) commitTails.delete(tabId);
  };
  void tail.then(clear, clear);
  return { started, execution };
};

/**
 * Serializes every server-side viewport mutation for one desktop runtime tab.
 * Both visible UI commits and background automation use this queue so a
 * compensating rollback cannot overtake a newer resize.
 */
export function runBrowserViewportMutation<A>(
  tabId: string,
  mutation: () => Promise<A>,
  deadline?: BrowserViewportMutationDeadline,
): Promise<A> {
  return queueBrowserViewportMutation(tabId, mutation, deadline).execution;
}

export function subscribeBrowserViewportChange(
  tabId: string,
  handler: BrowserViewportHandler,
): () => void {
  handlers.set(tabId, handler);
  return () => {
    if (handlers.get(tabId) === handler) handlers.delete(tabId);
  };
}

export function commitBrowserViewportChange(
  tabId: string,
  setting: PreviewViewportSetting,
): Promise<void> {
  const deadlineAt = Date.now() + BROWSER_VIEWPORT_COMMIT_TIMEOUT_MS;
  const deadline = {
    deadlineAt,
    timeoutError: () => new BrowserViewportCommitTimeoutError(tabId),
  };
  return queueBrowserViewportMutation(
    tabId,
    () => {
      const handler = handlers.get(tabId);
      return handler
        ? handler(setting)
        : Promise.reject(new Error(`No visible browser viewport handler for tab ${tabId}`));
    },
    deadline,
  ).execution;
}
