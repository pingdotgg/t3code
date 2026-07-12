import { textAttachmentPaths } from "./textAttachmentPaths";

export function isTextAttachmentReferenced(path: string, prompts: ReadonlyArray<string>): boolean {
  return prompts.some((prompt) => textAttachmentPaths(prompt).includes(path));
}

export class DeferredTextAttachmentCleanup {
  readonly #delayMs: number;
  readonly #maxRetries: number;
  readonly #pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(delayMs = 1_000, maxRetries = 1) {
    this.#delayMs = delayMs;
    this.#maxRetries = maxRetries;
  }

  schedule(
    path: string,
    options: {
      isReferenced: () => boolean;
      deletePath: () => boolean | void | Promise<boolean | void>;
    },
  ): void {
    this.cancel(path);
    this.#scheduleAttempt(path, options, this.#maxRetries);
  }

  #scheduleAttempt(
    path: string,
    options: {
      isReferenced: () => boolean;
      deletePath: () => boolean | void | Promise<boolean | void>;
    },
    retriesRemaining: number,
  ): void {
    const timeout = setTimeout(async () => {
      this.#pending.delete(path);
      if (options.isReferenced()) return;
      try {
        const deleted = await options.deletePath();
        if (deleted === false && retriesRemaining > 0) {
          this.#scheduleAttempt(path, options, retriesRemaining - 1);
        }
      } catch {
        if (retriesRemaining > 0) {
          this.#scheduleAttempt(path, options, retriesRemaining - 1);
        }
      }
    }, this.#delayMs);
    this.#pending.set(path, timeout);
  }

  cancel(path: string): void {
    const timeout = this.#pending.get(path);
    if (timeout === undefined) return;
    clearTimeout(timeout);
    this.#pending.delete(path);
  }
}
