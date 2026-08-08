import type { EnvironmentId, ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

export interface PendingServerPatch {
  readonly id: number;
  readonly patch: ServerSettingsPatch;
  readonly baseSettings: ServerSettings;
  readonly settledSettings?: ServerSettings;
}

interface PendingServerState {
  readonly patches: ReadonlyArray<PendingServerPatch>;
  /** Latest successful RPC result, used to rebase the next queued write. */
  readonly authoritativeSettings: ServerSettings;
  /** Latest settings snapshot published to React, which may precede its RPC result. */
  readonly observedSettings: ServerSettings;
}

export const NO_PENDING_SERVER_PATCHES: ReadonlyArray<PendingServerPatch> = [];

const pendingByEnvironment = new Map<EnvironmentId, PendingServerState>();
const listeners = new Set<() => void>();
let nextPendingPatchId = 1;

function emitChange(): void {
  for (const listener of listeners) listener();
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        structurallyEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function stableArrayElementKey(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as { readonly id?: unknown; readonly name?: unknown };
  if (typeof record.id === "string") return `id:${record.id}`;
  if (typeof record.name === "string") return `name:${record.name}`;
  return null;
}

function removeFirstStructurallyEqual(values: Array<unknown>, target: unknown): boolean {
  const index = values.findIndex((value) => structurallyEqual(value, target));
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
}

function rebaseArrayByValue(
  original: ReadonlyArray<unknown>,
  intended: ReadonlyArray<unknown>,
  current: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> {
  const unmatchedIntended = [...intended];
  const removed: Array<unknown> = [];
  for (const value of original) {
    if (!removeFirstStructurallyEqual(unmatchedIntended, value)) {
      removed.push(value);
    }
  }

  const unmatchedOriginal = [...original];
  const added = intended.filter(
    (value) => !removeFirstStructurallyEqual(unmatchedOriginal, value),
  );
  const rebased = [...current];
  for (const value of removed) {
    removeFirstStructurallyEqual(rebased, value);
  }
  rebased.push(...added);
  return rebased;
}

function rebaseArrayById(
  original: ReadonlyArray<unknown>,
  intended: ReadonlyArray<unknown>,
  current: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> {
  const originalById = new Map(original.map((value) => [stableArrayElementKey(value), value]));
  const intendedById = new Map(intended.map((value) => [stableArrayElementKey(value), value]));
  const rebased = [...current];

  for (const id of originalById.keys()) {
    if (intendedById.has(id)) continue;
    const index = rebased.findIndex((value) => stableArrayElementKey(value) === id);
    if (index >= 0) rebased.splice(index, 1);
  }
  for (const [id, intendedValue] of intendedById) {
    const originalValue = originalById.get(id);
    if (originalValue !== undefined && structurallyEqual(originalValue, intendedValue)) continue;
    const currentIndex = rebased.findIndex((value) => stableArrayElementKey(value) === id);
    const rebasedValue =
      originalValue === undefined
        ? intendedValue
        : rebaseChangedValue(originalValue, intendedValue, rebased[currentIndex]);
    if (currentIndex < 0) {
      rebased.push(rebasedValue);
    } else {
      rebased[currentIndex] = rebasedValue;
    }
  }
  return rebased;
}

function rebaseArray(
  original: ReadonlyArray<unknown>,
  intended: ReadonlyArray<unknown>,
  current: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> {
  const allValues = [...original, ...intended, ...current];
  return allValues.length > 0 && allValues.every((value) => stableArrayElementKey(value) !== null)
    ? rebaseArrayById(original, intended, current)
    : rebaseArrayByValue(original, intended, current);
}

function rebaseChangedValue(original: unknown, intended: unknown, current: unknown): unknown {
  if (structurallyEqual(original, intended)) return current;
  if (
    Array.isArray(original) &&
    Array.isArray(intended) &&
    (Array.isArray(current) || current === undefined)
  ) {
    return rebaseArray(original, intended, current ?? []);
  }
  if (
    typeof original !== "object" ||
    original === null ||
    typeof intended !== "object" ||
    intended === null ||
    typeof current !== "object" ||
    current === null ||
    Array.isArray(original) ||
    Array.isArray(intended) ||
    Array.isArray(current)
  ) {
    return intended;
  }

  const originalRecord = original as Readonly<Record<string, unknown>>;
  const intendedRecord = intended as Readonly<Record<string, unknown>>;
  const rebased = { ...(current as Readonly<Record<string, unknown>>) };
  const keys = new Set([...Object.keys(originalRecord), ...Object.keys(intendedRecord)]);
  for (const key of keys) {
    if (structurallyEqual(originalRecord[key], intendedRecord[key])) continue;
    const value = rebaseChangedValue(originalRecord[key], intendedRecord[key], rebased[key]);
    if (value === undefined) {
      delete rebased[key];
    } else {
      rebased[key] = value;
    }
  }
  return rebased;
}

function isSameModelTarget(
  left: ServerSettings["textGenerationModelSelection"],
  right: ServerSettings["textGenerationModelSelection"],
): boolean {
  return left.instanceId === right.instanceId && left.model === right.model;
}

function rebaseModelSelection(
  original: ServerSettings["textGenerationModelSelection"],
  intended: ServerSettings["textGenerationModelSelection"],
  current: ServerSettings["textGenerationModelSelection"],
): ServerSettings["textGenerationModelSelection"] {
  if (!isSameModelTarget(original, intended)) {
    return intended;
  }
  if (!isSameModelTarget(original, current)) {
    return current;
  }
  return rebaseChangedValue(
    original,
    intended,
    current,
  ) as ServerSettings["textGenerationModelSelection"];
}

/**
 * Preserve only the edits made by this operation when its original optimistic
 * base no longer matches the latest authoritative server settings.
 */
export function rebaseServerSettingsPatch(
  patch: ServerSettingsPatch,
  originalBase: ServerSettings,
  currentBase: ServerSettings,
): ServerSettingsPatch {
  const intended = applyServerSettingsPatch(originalBase, patch);
  const rebased: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    rebased[key] =
      key === "textGenerationModelSelection"
        ? rebaseModelSelection(
            originalBase.textGenerationModelSelection,
            intended.textGenerationModelSelection,
            currentBase.textGenerationModelSelection,
          )
        : rebaseChangedValue(
            originalBase[key as keyof ServerSettings],
            intended[key as keyof ServerSettings],
            currentBase[key as keyof ServerSettings],
          );
  }
  return rebased as ServerSettingsPatch;
}

export function subscribePendingServerPatches(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPendingServerPatches(
  environmentId: EnvironmentId | null,
): ReadonlyArray<PendingServerPatch> {
  if (environmentId === null) return NO_PENDING_SERVER_PATCHES;
  return pendingByEnvironment.get(environmentId)?.patches ?? NO_PENDING_SERVER_PATCHES;
}

export function applyPendingServerPatches(
  settings: ServerSettings,
  patches: ReadonlyArray<PendingServerPatch>,
): ServerSettings {
  return patches.reduce((current, pending) => {
    const rebasedPatch = rebaseServerSettingsPatch(
      pending.patch,
      pending.baseSettings,
      current,
    );
    return applyServerSettingsPatch(current, rebasedPatch);
  }, settings);
}

export function retainPendingServerPatch(
  environmentId: EnvironmentId,
  patch: ServerSettingsPatch,
  baseSettings: ServerSettings,
  authoritativeSettings: ServerSettings,
): number {
  const existing = pendingByEnvironment.get(environmentId);
  const id = nextPendingPatchId++;
  pendingByEnvironment.set(environmentId, {
    patches: [...(existing?.patches ?? NO_PENDING_SERVER_PATCHES), { id, patch, baseSettings }],
    authoritativeSettings: existing?.authoritativeSettings ?? authoritativeSettings,
    observedSettings: existing?.observedSettings ?? authoritativeSettings,
  });
  emitChange();
  return id;
}

export function getPendingServerPatchForDispatch(
  environmentId: EnvironmentId,
  id: number,
): ServerSettingsPatch | null {
  const state = pendingByEnvironment.get(environmentId);
  const pending = state?.patches.find((entry) => entry.id === id);
  if (!state || !pending) return null;
  return rebaseServerSettingsPatch(
    pending.patch,
    pending.baseSettings,
    state.authoritativeSettings,
  );
}

export function settlePendingServerPatch(
  environmentId: EnvironmentId,
  id: number,
  settings: ServerSettings | null,
): void {
  const state = pendingByEnvironment.get(environmentId);
  if (!state) return;
  const settledIndex = state.patches.findIndex((entry) => entry.id === id);
  const settingsWereAlreadyObserved =
    settings !== null &&
    settledIndex >= 0 &&
    structurallyEqual(state.observedSettings, settings);
  const patches =
    settings === null
      ? state.patches.filter((entry) => entry.id !== id)
      : settingsWereAlreadyObserved
        ? state.patches.slice(settledIndex + 1)
        : state.patches.map((entry) =>
            entry.id === id ? { ...entry, settledSettings: settings } : entry,
          );
  if (patches.length === 0) {
    pendingByEnvironment.delete(environmentId);
  } else {
    pendingByEnvironment.set(environmentId, {
      patches,
      authoritativeSettings: settings ?? state.authoritativeSettings,
      observedSettings: state.observedSettings,
    });
  }
  emitChange();
}

/**
 * Retire successful overlays only when their actual settingsUpdated payload is
 * observed. An initial config snapshot cannot acknowledge a write accidentally.
 */
export function acknowledgePendingServerSettings(
  environmentId: EnvironmentId,
  settings: ServerSettings,
): void {
  const state = pendingByEnvironment.get(environmentId);
  if (!state) return;
  const acknowledgedIndex = state.patches.findLastIndex(
    (entry) =>
      entry.settledSettings !== undefined && structurallyEqual(entry.settledSettings, settings),
  );
  if (acknowledgedIndex >= 0) {
    const patches = state.patches.slice(acknowledgedIndex + 1);
    if (patches.length === 0) {
      pendingByEnvironment.delete(environmentId);
    } else {
      pendingByEnvironment.set(environmentId, {
        patches,
        authoritativeSettings: patches.reduce(
          (latest, entry) => entry.settledSettings ?? latest,
          settings,
        ),
        observedSettings: settings,
      });
    }
    emitChange();
    return;
  }
  pendingByEnvironment.set(environmentId, {
    ...state,
    ...(state.patches.some((entry) => entry.settledSettings !== undefined)
      ? {}
      : { authoritativeSettings: settings }),
    observedSettings: settings,
  });
}

export function __resetPendingServerPatchesForTests(): void {
  pendingByEnvironment.clear();
  listeners.clear();
  nextPendingPatchId = 1;
}
