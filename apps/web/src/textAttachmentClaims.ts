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
  #paused = false;

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
    if (!this.#paused) this.#enqueueReconcile();
  }

  confirmPaths(paths: Iterable<string>): void {
    if (this.#disposed) return;
    for (const path of paths) this.#confirmed.add(path);
  }

  invalidateDesiredConfirmations(): void {
    if (this.#disposed) return;
    for (const path of this.#desired) this.#confirmed.delete(path);
  }

  reconcileNow(): void {
    if (this.#disposed || this.#paused) return;
    this.#retryCount = 0;
    this.#clearRetry();
    this.#enqueueReconcile();
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearRetry();
  }

  async pause(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    this.#clearRetry();
    await this.#queue;
  }

  resume(): void {
    if (this.#disposed || !this.#paused) return;
    this.#paused = false;
    this.reconcileNow();
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
    if (this.#disposed || this.#paused) return;
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
    if (this.#retryTimer !== null || this.#disposed || this.#paused) return;
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

export async function pauseTextAttachmentClaimEnvironment(
  environmentId: EnvironmentId,
): Promise<void> {
  const prefix = `${environmentId}:`;
  await Promise.all(
    [...textAttachmentClaimReconcilerRegistry.entries()].flatMap(([key, reconciler]) =>
      key.startsWith(prefix) ? [reconciler.pause()] : [],
    ),
  );
}

export function resumeTextAttachmentClaimEnvironment(environmentId: EnvironmentId): void {
  const prefix = `${environmentId}:`;
  for (const [key, reconciler] of textAttachmentClaimReconcilerRegistry) {
    if (!key.startsWith(prefix)) continue;
    reconciler.invalidateDesiredConfirmations();
    reconciler.resume();
  }
}

export function resetTextAttachmentClaimRegistryForTest(): void {
  for (const reconciler of textAttachmentClaimReconcilerRegistry.values()) reconciler.dispose();
  textAttachmentClaimReconcilerRegistry.clear();
  textAttachmentUploadRegistry.clear();
  fencedTextAttachmentUploadEnvironmentIds.clear();
}

interface TextAttachmentUploadOwnerState {
  fenced: boolean;
  pending: Set<Promise<void>>;
}

const textAttachmentUploadRegistry = new Map<string, TextAttachmentUploadOwnerState>();
const fencedTextAttachmentUploadEnvironmentIds = new Set<EnvironmentId>();

function textAttachmentUploadOwnerState(
  environmentId: EnvironmentId,
  draftOwnerId: string,
): TextAttachmentUploadOwnerState {
  const key = textAttachmentClaimRegistryKey(environmentId, draftOwnerId);
  const existing = textAttachmentUploadRegistry.get(key);
  if (existing) return existing;
  const state = { fenced: false, pending: new Set<Promise<void>>() };
  textAttachmentUploadRegistry.set(key, state);
  return state;
}

export async function runTextAttachmentUpload<T>(input: {
  environmentId: EnvironmentId;
  draftOwnerId: string;
  upload: () => Promise<T>;
  path: (result: T) => string | null;
  release: (path: string) => Promise<void>;
}): Promise<T | null> {
  if (fencedTextAttachmentUploadEnvironmentIds.has(input.environmentId)) return null;
  const state = textAttachmentUploadOwnerState(input.environmentId, input.draftOwnerId);
  if (state.fenced) return null;
  let finish: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  state.pending.add(pending);
  try {
    const result = await input.upload();
    if (!state.fenced) return result;
    const path = input.path(result);
    if (path) await input.release(path);
    return null;
  } finally {
    state.pending.delete(pending);
    finish();
  }
}

export async function fenceTextAttachmentUploadOwner(
  environmentId: EnvironmentId,
  draftOwnerId: string,
): Promise<void> {
  const state = textAttachmentUploadOwnerState(environmentId, draftOwnerId);
  state.fenced = true;
  await Promise.all(state.pending);
}

export async function fenceTextAttachmentUploadEnvironment(
  environmentId: EnvironmentId,
): Promise<void> {
  fencedTextAttachmentUploadEnvironmentIds.add(environmentId);
  const prefix = `${environmentId}:`;
  const waits: Promise<void>[] = [];
  for (const [key, state] of textAttachmentUploadRegistry) {
    if (!key.startsWith(prefix)) continue;
    state.fenced = true;
    waits.push(...state.pending);
  }
  await Promise.all(waits);
}

export function resumeTextAttachmentUploadEnvironment(environmentId: EnvironmentId): void {
  fencedTextAttachmentUploadEnvironmentIds.delete(environmentId);
  const prefix = `${environmentId}:`;
  for (const [key, state] of textAttachmentUploadRegistry) {
    if (key.startsWith(prefix)) state.fenced = false;
  }
}

export function clearTextAttachmentUploadEnvironment(environmentId: EnvironmentId): void {
  fencedTextAttachmentUploadEnvironmentIds.delete(environmentId);
  const prefix = `${environmentId}:`;
  for (const key of textAttachmentUploadRegistry.keys()) {
    if (key.startsWith(prefix)) textAttachmentUploadRegistry.delete(key);
  }
}
