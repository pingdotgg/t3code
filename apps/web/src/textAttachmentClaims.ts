import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import {
  completePendingTextAttachmentRelease,
  pendingTextAttachmentReleasesEnvironment,
  persistPendingTextAttachmentReleases,
  type ComposerThreadTarget,
  type DraftId,
} from "./composerDraftStore";
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
  #claim: (path: string) => Promise<boolean>;
  #release: (path: string) => Promise<boolean>;
  readonly #retryDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #operationTimeoutMs: number;
  #desired = new Set<string>();
  #confirmed = new Set<string>();
  #queue: Promise<void> = Promise.resolve();
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #retryCount = 0;
  #reconcilePending = false;
  #reconcileRequested = false;
  #disposed = false;
  #paused = false;

  constructor(options: {
    claim: (path: string) => Promise<boolean>;
    release: (path: string) => Promise<boolean>;
    retryDelayMs?: number;
    maxRetryDelayMs?: number;
    operationTimeoutMs?: number;
  }) {
    this.#claim = options.claim;
    this.#release = options.release;
    this.#retryDelayMs = options.retryDelayMs ?? 250;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.#operationTimeoutMs = options.operationTimeoutMs ?? 10_000;
  }

  setDesiredPrompt(prompt: string): boolean {
    return this.setDesiredPaths(textAttachmentPaths(prompt));
  }

  setOperations(operations: {
    claim: (path: string) => Promise<boolean>;
    release: (path: string) => Promise<boolean>;
  }): void {
    this.#claim = operations.claim;
    this.#release = operations.release;
  }

  setDesiredPaths(paths: Iterable<string>): boolean {
    if (this.#disposed) return false;
    const nextDesired = new Set(paths);
    if (
      nextDesired.size === this.#desired.size &&
      [...nextDesired].every((path) => this.#desired.has(path))
    ) {
      return false;
    }
    this.#desired = nextDesired;
    this.#retryCount = 0;
    this.#clearRetry();
    if (!this.#paused) this.#enqueueReconcile(true);
    return true;
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
    if (this.#reconcilePending) return;
    this.#retryCount = 0;
    this.#clearRetry();
    this.#enqueueReconcile(true);
  }

  reconcileIfNeeded(): void {
    if (this.#disposed || this.#paused || this.#retryTimer !== null || !this.#hasPendingChanges()) {
      return;
    }
    this.#enqueueReconcile(false);
  }

  dispose(): void {
    this.#disposed = true;
    this.#reconcileRequested = false;
    this.#clearRetry();
  }

  async pause(): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    this.#reconcileRequested = false;
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

  #enqueueReconcile(requestAfterPending: boolean): void {
    if (this.#disposed || this.#paused) return;
    if (this.#reconcilePending) {
      if (requestAfterPending) this.#reconcileRequested = true;
      return;
    }
    this.#reconcilePending = true;
    this.#queue = this.#queue
      .catch(() => undefined)
      .then(() => this.#reconcile())
      .finally(() => {
        this.#reconcilePending = false;
        if (!this.#reconcileRequested || this.#disposed || this.#paused) return;
        this.#reconcileRequested = false;
        this.#retryCount = 0;
        this.#clearRetry();
        this.#enqueueReconcile(false);
      });
  }

  async #reconcile(): Promise<void> {
    if (this.#disposed) return;
    let failed = false;
    for (const path of this.#desired) {
      if (this.#confirmed.has(path)) continue;
      if (await this.#runOperation(() => this.#claim(path))) this.#confirmed.add(path);
      else failed = true;
    }
    for (const path of this.#confirmed) {
      if (this.#desired.has(path)) continue;
      if (await this.#runOperation(() => this.#release(path))) this.#confirmed.delete(path);
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
      this.#enqueueReconcile(false);
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryTimer === null) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  async #runOperation(operation: () => Promise<boolean>): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return Promise.race([
      Promise.resolve()
        .then(operation)
        .catch(() => false),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), this.#operationTimeoutMs);
      }),
    ]).finally(() => {
      if (timeout !== null) clearTimeout(timeout);
    });
  }

  #hasPendingChanges(): boolean {
    for (const path of this.#desired) {
      if (!this.#confirmed.has(path)) return true;
    }
    for (const path of this.#confirmed) {
      if (!this.#desired.has(path)) return true;
    }
    return false;
  }
}

export async function retryTextAttachmentOperation(
  operation: () => Promise<boolean>,
  options: {
    retryDelayMs?: number;
    maxRetryDelayMs?: number;
    maxAttempts?: number;
    signal?: AbortSignal;
  } = {},
): Promise<boolean> {
  const retryDelayMs = options.retryDelayMs ?? 100;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 5;
  for (let attempt = 0; attempt < maxAttempts && !options.signal?.aborted; attempt += 1) {
    if (await operation()) return true;
    if (attempt + 1 >= maxAttempts) return false;
    const delay = Math.min(retryDelayMs * 2 ** Math.min(attempt, 30), maxRetryDelayMs);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
  return false;
}

export function detachedTextAttachmentReleaseComplete(result: { readonly _tag: string }): boolean {
  return result._tag === "Success";
}

export interface TextAttachmentClaimRelease {
  readonly path: string;
  readonly draftOwnerId: string;
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
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  operationTimeoutMs?: number;
}): TextAttachmentClaimReconciler {
  const key = textAttachmentClaimRegistryKey(input.environmentId, input.draftOwnerId);
  const existing = textAttachmentClaimReconcilerRegistry.get(key);
  if (existing) {
    existing.setOperations({
      claim: (path) => input.operations.claim(path, input.draftOwnerId),
      release: (path) => input.operations.release(path, input.draftOwnerId),
    });
    return existing;
  }
  const reconciler = new TextAttachmentClaimReconciler({
    claim: (path) => input.operations.claim(path, input.draftOwnerId),
    release: (path) => input.operations.release(path, input.draftOwnerId),
    ...(input.retryDelayMs === undefined ? {} : { retryDelayMs: input.retryDelayMs }),
    ...(input.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: input.maxRetryDelayMs }),
    ...(input.operationTimeoutMs === undefined
      ? {}
      : { operationTimeoutMs: input.operationTimeoutMs }),
  });
  textAttachmentClaimReconcilerRegistry.set(key, reconciler);
  return reconciler;
}

export async function releaseTextAttachmentClaimsInBackground(input: {
  environmentId: EnvironmentId;
  claims: ReadonlyArray<TextAttachmentClaimRelease>;
  draftOwnerIds?: ReadonlyArray<string>;
  release: (claim: TextAttachmentClaimRelease) => Promise<boolean>;
  foregroundWaitMs?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  operationTimeoutMs?: number;
}): Promise<{
  readonly durable: boolean;
  readonly rejected: ReadonlyArray<TextAttachmentClaimRelease>;
}> {
  const claimsByOwner = new Map<string, Set<string>>();
  for (const draftOwnerId of input.draftOwnerIds ?? []) {
    claimsByOwner.set(draftOwnerId, new Set());
  }
  for (const { path, draftOwnerId } of input.claims) {
    const paths = claimsByOwner.get(draftOwnerId) ?? new Set<string>();
    paths.add(path);
    claimsByOwner.set(draftOwnerId, paths);
  }
  const owners = [...claimsByOwner].map(([draftOwnerId, paths]) => {
    const reconciler = getTextAttachmentClaimReconciler({
      environmentId: input.environmentId,
      draftOwnerId,
      operations: {
        claim: async () => false,
        release: async (path, ownerId) => {
          const release = { environmentId: input.environmentId, path, draftOwnerId: ownerId };
          const released = await input.release(release);
          if (released) completePendingTextAttachmentRelease(release);
          return released;
        },
      },
      ...(input.retryDelayMs === undefined ? {} : { retryDelayMs: input.retryDelayMs }),
      ...(input.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: input.maxRetryDelayMs }),
      ...(input.operationTimeoutMs === undefined
        ? {}
        : { operationTimeoutMs: input.operationTimeoutMs }),
    });
    for (const path of reconciler.snapshot().confirmed) paths.add(path);
    return { draftOwnerId, paths, reconciler };
  });
  const persistence = persistPendingTextAttachmentReleases(
    owners.flatMap(({ draftOwnerId, paths }) =>
      [...paths].map((path) => ({
        environmentId: input.environmentId,
        path,
        draftOwnerId,
      })),
    ),
  );
  const reconciliations = owners.map(({ paths, reconciler }) => {
    reconciler.confirmPaths(paths);
    reconciler.setDesiredPaths([]);
    reconciler.reconcileIfNeeded();
    return reconciler.settled();
  });
  if (reconciliations.length === 0) {
    return {
      durable: persistence.accepted,
      rejected: persistence.rejected.map(({ path, draftOwnerId }) => ({ path, draftOwnerId })),
    };
  }
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    Promise.all(reconciliations),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, input.foregroundWaitMs ?? 1_000);
    }),
  ]).finally(() => {
    if (timeout !== null) clearTimeout(timeout);
  });
  return {
    durable: persistence.accepted,
    rejected: persistence.rejected.map(({ path, draftOwnerId }) => ({ path, draftOwnerId })),
  };
}

export function pendingTextAttachmentClaimReleases(
  environmentId: EnvironmentId,
): TextAttachmentClaimRelease[] {
  return pendingTextAttachmentReleasesEnvironment(environmentId).map(({ path, draftOwnerId }) => ({
    path,
    draftOwnerId,
  }));
}

function restorePendingTextAttachmentClaimReleases(
  environmentId: EnvironmentId,
  operations: TextAttachmentClaimOperations,
  force: boolean,
): void {
  const claimsByOwner = new Map<string, Set<string>>();
  for (const { path, draftOwnerId } of pendingTextAttachmentReleasesEnvironment(environmentId)) {
    const paths = claimsByOwner.get(draftOwnerId) ?? new Set<string>();
    paths.add(path);
    claimsByOwner.set(draftOwnerId, paths);
  }
  for (const [draftOwnerId, paths] of claimsByOwner) {
    const reconciler = getTextAttachmentClaimReconciler({
      environmentId,
      draftOwnerId,
      operations: {
        claim: operations.claim,
        release: async (path, ownerId) => {
          const release = { environmentId, path, draftOwnerId: ownerId };
          const released = await operations.release(path, ownerId);
          if (released) completePendingTextAttachmentRelease(release);
          return released;
        },
      },
    });
    reconciler.confirmPaths(paths);
    reconciler.setDesiredPaths([]);
    if (force) reconciler.reconcileNow();
    else reconciler.reconcileIfNeeded();
  }
}

export function reconcileTextAttachmentClaimsEnvironment(
  environmentId: EnvironmentId,
  entries: ReadonlyArray<{ target: ComposerThreadTarget; prompt: string }>,
  operations: TextAttachmentClaimOperations,
  options: { readonly force?: boolean } = {},
): void {
  for (const { target, prompt } of entries) {
    const draftOwnerId = textAttachmentDraftOwnerId(target);
    const reconciler = getTextAttachmentClaimReconciler({
      environmentId,
      draftOwnerId,
      operations,
    });
    const desiredChanged = reconciler.setDesiredPrompt(prompt);
    if (options.force === true && !desiredChanged) reconciler.reconcileNow();
  }
  restorePendingTextAttachmentClaimReleases(environmentId, operations, options.force === true);
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

export function resumeTextAttachmentUploadOwner(
  environmentId: EnvironmentId,
  draftOwnerId: string,
): void {
  const state = textAttachmentUploadRegistry.get(
    textAttachmentClaimRegistryKey(environmentId, draftOwnerId),
  );
  if (state) state.fenced = false;
}

export function tombstoneTextAttachmentUploadOwner(
  environmentId: EnvironmentId,
  draftOwnerId: string,
): void {
  const state = textAttachmentUploadOwnerState(environmentId, draftOwnerId);
  state.fenced = true;
  state.pending.clear();
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
