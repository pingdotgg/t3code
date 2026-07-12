import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

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
  readonly #maxRetryDelayMs: number;
  #desired = new Set<string>();
  #confirmed = new Set<string>();
  #queue: Promise<void> = Promise.resolve();
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #retryCount = 0;
  #disposed = false;

  constructor(options: {
    claim: (path: string) => Promise<boolean>;
    release: (path: string) => Promise<boolean>;
    retryDelayMs?: number;
    maxRetryDelayMs?: number;
  }) {
    this.#claim = options.claim;
    this.#release = options.release;
    this.#retryDelayMs = options.retryDelayMs ?? 250;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
  }

  setDesiredPrompt(prompt: string): void {
    this.setDesiredPaths(textAttachmentPaths(prompt));
  }

  setDesiredPaths(paths: Iterable<string>): void {
    if (this.#disposed) return;
    this.#desired = new Set(paths);
    this.#retryCount = 0;
    this.#clearRetry();
    this.#enqueueReconcile();
  }

  confirmPaths(paths: Iterable<string>): void {
    if (this.#disposed) return;
    for (const path of paths) this.#confirmed.add(path);
  }

  reconcileNow(): void {
    if (this.#disposed) return;
    this.#retryCount = 0;
    this.#clearRetry();
    this.#enqueueReconcile();
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearRetry();
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
    if (this.#disposed) return;
    this.#queue = this.#queue.catch(() => undefined).then(() => this.#reconcile());
  }

  async #reconcile(): Promise<void> {
    if (this.#disposed) return;
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
    if (this.#retryTimer !== null || this.#disposed) return;
    const delay = Math.min(
      this.#retryDelayMs * 2 ** Math.min(this.#retryCount, 30),
      this.#maxRetryDelayMs,
    );
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
  options: { retryDelayMs?: number; maxRetryDelayMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  const retryDelayMs = options.retryDelayMs ?? 100;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
  for (let attempt = 0; !options.signal?.aborted; attempt += 1) {
    if (await operation()) return true;
    const delay = Math.min(retryDelayMs * 2 ** Math.min(attempt, 30), maxRetryDelayMs);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
  return false;
}

export function detachedTextAttachmentReleaseComplete(result: { readonly _tag: string }): boolean {
  return result._tag === "Success";
}

export interface TextAttachmentClaimOperations {
  claim: (path: string, draftOwnerId: string) => Promise<boolean>;
  release: (path: string, draftOwnerId: string) => Promise<boolean>;
}

const textAttachmentClaimReconcilerRegistry = new Map<string, TextAttachmentClaimReconciler>();

function textAttachmentClaimRegistryKey(
  environmentId: EnvironmentId,
  draftOwnerId: string,
): string {
  return `${environmentId}:${draftOwnerId}`;
}

export function getTextAttachmentClaimReconciler(input: {
  environmentId: EnvironmentId;
  draftOwnerId: string;
  operations: TextAttachmentClaimOperations;
}): TextAttachmentClaimReconciler {
  const key = textAttachmentClaimRegistryKey(input.environmentId, input.draftOwnerId);
  const existing = textAttachmentClaimReconcilerRegistry.get(key);
  if (existing) return existing;
  const reconciler = new TextAttachmentClaimReconciler({
    claim: (path) => input.operations.claim(path, input.draftOwnerId),
    release: (path) => input.operations.release(path, input.draftOwnerId),
  });
  textAttachmentClaimReconcilerRegistry.set(key, reconciler);
  return reconciler;
}

export function reconcileTextAttachmentClaimsEnvironment(
  environmentId: EnvironmentId,
  entries: ReadonlyArray<{ target: ComposerThreadTarget; prompt: string }>,
  operations: TextAttachmentClaimOperations,
): void {
  for (const { target, prompt } of entries) {
    const draftOwnerId = textAttachmentDraftOwnerId(target);
    const reconciler = getTextAttachmentClaimReconciler({
      environmentId,
      draftOwnerId,
      operations,
    });
    reconciler.setDesiredPrompt(prompt);
    reconciler.reconcileNow();
  }
}

export async function detachTextAttachmentClaimOwner(
  environmentId: EnvironmentId,
  draftOwnerId: string,
): Promise<void> {
  const key = textAttachmentClaimRegistryKey(environmentId, draftOwnerId);
  const reconciler = textAttachmentClaimReconcilerRegistry.get(key);
  if (!reconciler) return;
  textAttachmentClaimReconcilerRegistry.delete(key);
  reconciler.dispose();
  await reconciler.settled();
}

export function disposeTextAttachmentClaimEnvironment(environmentId: EnvironmentId): void {
  const prefix = `${environmentId}:`;
  for (const [key, reconciler] of textAttachmentClaimReconcilerRegistry) {
    if (!key.startsWith(prefix)) continue;
    reconciler.dispose();
    textAttachmentClaimReconcilerRegistry.delete(key);
  }
}

export function resetTextAttachmentClaimRegistryForTest(): void {
  for (const reconciler of textAttachmentClaimReconcilerRegistry.values()) reconciler.dispose();
  textAttachmentClaimReconcilerRegistry.clear();
}
