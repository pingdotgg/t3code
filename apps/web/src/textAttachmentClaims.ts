import type { ScopedThreadRef } from "@t3tools/contracts";

import type { ComposerThreadTarget, DraftId } from "./composerDraftStore";
import { textAttachmentPaths } from "./textAttachmentPaths";

export function textAttachmentDraftOwnerId(target: ScopedThreadRef | DraftId): string {
  return typeof target === "string"
    ? `draft:${target}`
    : `thread:${target.environmentId}:${target.threadId}`;
}

export function textAttachmentClaimChanges(
  previousPaths: ReadonlySet<string>,
  prompt: string,
): { claim: string[]; release: string[]; nextPaths: Set<string> } {
  const nextPaths = new Set(textAttachmentPaths(prompt));
  return {
    claim: [...nextPaths].filter((path) => !previousPaths.has(path)),
    release: [...previousPaths].filter((path) => !nextPaths.has(path)),
    nextPaths,
  };
}

export function textAttachmentClaims(
  target: ComposerThreadTarget,
  prompt: string,
): Array<{ path: string; draftOwnerId: string }> {
  const draftOwnerId = textAttachmentDraftOwnerId(target);
  return textAttachmentPaths(prompt).map((path) => ({ path, draftOwnerId }));
}

export class TextAttachmentClaimReconciler {
  readonly #claim: (path: string) => Promise<boolean>;
  readonly #release: (path: string) => Promise<boolean>;
  readonly #retryDelayMs: number;
  readonly #maxRetries: number;
  #desired = new Set<string>();
  #confirmed = new Set<string>();
  #queue: Promise<void> = Promise.resolve();
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #retryCount = 0;

  constructor(options: {
    claim: (path: string) => Promise<boolean>;
    release: (path: string) => Promise<boolean>;
    retryDelayMs?: number;
    maxRetries?: number;
  }) {
    this.#claim = options.claim;
    this.#release = options.release;
    this.#retryDelayMs = options.retryDelayMs ?? 250;
    this.#maxRetries = options.maxRetries ?? 3;
  }

  setDesiredPrompt(prompt: string): void {
    this.setDesiredPaths(textAttachmentPaths(prompt));
  }

  setDesiredPaths(paths: Iterable<string>): void {
    this.#desired = new Set(paths);
    this.#retryCount = 0;
    this.#clearRetry();
    this.#enqueueReconcile();
  }

  confirmPaths(paths: Iterable<string>): void {
    for (const path of paths) this.#confirmed.add(path);
  }

  snapshot(): { desired: Set<string>; confirmed: Set<string> } {
    return {
      desired: new Set(this.#desired),
      confirmed: new Set(this.#confirmed),
    };
  }

  async settled(): Promise<void> {
    await this.#queue;
  }

  #enqueueReconcile(): void {
    this.#queue = this.#queue.catch(() => undefined).then(() => this.#reconcile());
  }

  async #reconcile(): Promise<void> {
    let failed = false;
    for (const path of this.#desired) {
      if (this.#confirmed.has(path)) continue;
      if (await this.#claim(path)) this.#confirmed.add(path);
      else failed = true;
    }
    for (const path of this.#confirmed) {
      if (this.#desired.has(path)) continue;
      if (await this.#release(path)) this.#confirmed.delete(path);
      else failed = true;
    }
    if (!failed) {
      this.#retryCount = 0;
      return;
    }
    if (this.#retryCount >= this.#maxRetries || this.#retryTimer !== null) return;
    const delay = this.#retryDelayMs * 2 ** this.#retryCount;
    this.#retryCount += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#enqueueReconcile();
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryTimer === null) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }
}

export async function retryTextAttachmentOperation(
  operation: () => Promise<boolean>,
  options: { maxAttempts?: number; retryDelayMs?: number } = {},
): Promise<boolean> {
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 100;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await operation()) return true;
    if (attempt + 1 < maxAttempts) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));
    }
  }
  return false;
}
