import type { PreviewViewportSetting } from "@t3tools/contracts";

type BrowserViewportHandler = (setting: PreviewViewportSetting) => Promise<void>;

export const BROWSER_VIEWPORT_COMMIT_TIMEOUT_MS = 15_000;

export class BrowserViewportCommitTimeoutError extends Error {
  override readonly name = "BrowserViewportCommitTimeoutError";

  constructor(readonly tabId: string) {
    super(`Timed out committing the browser viewport for tab ${tabId}`);
  }
}

const handlers = new Map<string, BrowserViewportHandler>();
const commitTails = new Map<string, Promise<void>>();

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
  const previous = commitTails.get(tabId) ?? Promise.resolve();
  const started = previous
    .catch(() => undefined)
    .then(() => {
      const handler = handlers.get(tabId);
      const operation = handler
        ? Promise.resolve().then(() => handler(setting))
        : Promise.reject(new Error(`No visible browser viewport handler for tab ${tabId}`));
      return { operation };
    });
  // The queue follows the real handler lifetime, not the caller-facing timeout.
  // A slow commit therefore cannot time out, release the queue, and overwrite a
  // newer viewport after that newer request has already completed.
  const execution = started.then(({ operation }) => operation);
  const result = started.then(({ operation }) => runHandlerWithTimeout(tabId, operation));
  commitTails.set(tabId, execution);
  const clear = () => {
    if (commitTails.get(tabId) === execution) commitTails.delete(tabId);
  };
  void execution.then(clear, clear);
  return result;
}
