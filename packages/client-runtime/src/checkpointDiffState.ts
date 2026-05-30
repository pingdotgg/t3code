import {
  type EnvironmentId,
  OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

export type CheckpointDiffResult =
  | OrchestrationGetTurnDiffResult
  | OrchestrationGetFullThreadDiffResult;

export interface CheckpointDiffState {
  readonly data: CheckpointDiffResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

export interface CheckpointDiffTarget {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly fromTurnCount: number | null;
  readonly toTurnCount: number | null;
  readonly ignoreWhitespace: boolean;
  readonly cacheScope?: string | null;
}

export interface CheckpointDiffClient {
  readonly getTurnDiff: (
    input: OrchestrationGetTurnDiffInput,
  ) => Promise<OrchestrationGetTurnDiffResult>;
  readonly getFullThreadDiff: (
    input: OrchestrationGetFullThreadDiffInput,
  ) => Promise<OrchestrationGetFullThreadDiffResult>;
}

export const EMPTY_CHECKPOINT_DIFF_STATE = Object.freeze<CheckpointDiffState>({
  data: null,
  error: null,
  isPending: false,
});

const INITIAL_CHECKPOINT_DIFF_STATE = Object.freeze<CheckpointDiffState>({
  data: null,
  error: null,
  isPending: true,
});

const knownCheckpointDiffKeys = new Set<string>();

export const checkpointDiffStateAtom = Atom.family((key: string) => {
  knownCheckpointDiffKeys.add(key);
  return Atom.make(INITIAL_CHECKPOINT_DIFF_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`checkpoint-diff:${key}`),
  );
});

export const EMPTY_CHECKPOINT_DIFF_ATOM = Atom.make(EMPTY_CHECKPOINT_DIFF_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("checkpoint-diff:null"),
);

const decodeFullThreadDiffInput = Schema.decodeUnknownOption(OrchestrationGetFullThreadDiffInput);
const decodeTurnDiffInput = Schema.decodeUnknownOption(OrchestrationGetTurnDiffInput);

type CheckpointDiffRequest =
  | {
      readonly kind: "fullThreadDiff";
      readonly input: OrchestrationGetFullThreadDiffInput;
    }
  | {
      readonly kind: "turnDiff";
      readonly input: OrchestrationGetTurnDiffInput;
    };

export function getCheckpointDiffTargetKey(target: CheckpointDiffTarget): string | null {
  const decoded = decodeCheckpointDiffRequest(target);
  if (target.environmentId === null || decoded._tag === "None") {
    return null;
  }

  return [
    target.environmentId,
    target.threadId,
    target.fromTurnCount,
    target.toTurnCount,
    target.ignoreWhitespace,
    target.cacheScope ?? null,
  ].join(":");
}

function decodeCheckpointDiffRequest(target: CheckpointDiffTarget) {
  if (target.fromTurnCount === 0) {
    return decodeFullThreadDiffInput({
      threadId: target.threadId,
      toTurnCount: target.toTurnCount,
      ignoreWhitespace: target.ignoreWhitespace,
    }).pipe(Option.map((input) => ({ kind: "fullThreadDiff" as const, input })));
  }

  return decodeTurnDiffInput({
    threadId: target.threadId,
    fromTurnCount: target.fromTurnCount,
    toTurnCount: target.toTurnCount,
    ignoreWhitespace: target.ignoreWhitespace,
  }).pipe(Option.map((input) => ({ kind: "turnDiff" as const, input })));
}

function asCheckpointErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "";
}

export function normalizeCheckpointDiffErrorMessage(error: unknown): string {
  const message = asCheckpointErrorMessage(error).trim();
  if (message.length === 0) {
    return "Failed to load checkpoint diff.";
  }

  const lower = message.toLowerCase();
  if (lower.includes("not a git repository")) {
    return "Turn diffs are unavailable because this project is not a git repository.";
  }

  if (
    lower.includes("checkpoint unavailable for thread") ||
    lower.includes("checkpoint invariant violation")
  ) {
    const separatorIndex = message.indexOf(":");
    if (separatorIndex >= 0) {
      const detail = message.slice(separatorIndex + 1).trim();
      if (detail.length > 0) {
        return detail;
      }
    }
  }

  return message;
}

function isCheckpointTemporarilyUnavailable(error: unknown): boolean {
  const message = asCheckpointErrorMessage(error).toLowerCase();
  return (
    message.includes("exceeds current turn count") ||
    message.includes("checkpoint is unavailable for turn") ||
    message.includes("filesystem checkpoint is unavailable")
  );
}

function defaultRetryDelay(attempt: number, error: unknown): Promise<void> {
  const delayMs = isCheckpointTemporarilyUnavailable(error)
    ? Math.min(5_000, 250 * 2 ** (attempt - 1))
    : Math.min(1_000, 100 * 2 ** (attempt - 1));
  return Effect.runPromise(Effect.sleep(Duration.millis(delayMs)));
}

export function createCheckpointDiffManager(config: {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly getClient: (environmentId: EnvironmentId) => CheckpointDiffClient | null;
  readonly retryDelay?: (attempt: number, error: unknown) => Promise<void>;
}) {
  const inFlight = new Map<string, Promise<CheckpointDiffResult | null>>();
  const versions = new Map<string, number>();

  function getVersion(targetKey: string): number {
    return versions.get(targetKey) ?? 0;
  }

  function bumpVersion(targetKey: string): void {
    versions.set(targetKey, getVersion(targetKey) + 1);
  }

  function setState(targetKey: string, state: CheckpointDiffState): void {
    config.getRegistry().set(checkpointDiffStateAtom(targetKey), state);
  }

  function markPending(targetKey: string): void {
    const current = config.getRegistry().get(checkpointDiffStateAtom(targetKey));
    setState(
      targetKey,
      current.data === null ? INITIAL_CHECKPOINT_DIFF_STATE : { ...current, isPending: true },
    );
  }

  function setError(targetKey: string, error: unknown): void {
    const current = config.getRegistry().get(checkpointDiffStateAtom(targetKey));
    setState(targetKey, {
      data: current.data,
      error: normalizeCheckpointDiffErrorMessage(error),
      isPending: false,
    });
  }

  async function requestWithRetry(
    client: CheckpointDiffClient,
    request: CheckpointDiffRequest,
  ): Promise<CheckpointDiffResult> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        if (request.kind === "fullThreadDiff") {
          return await client.getFullThreadDiff(request.input);
        }
        return await client.getTurnDiff(request.input);
      } catch (error) {
        const maxAttempts = isCheckpointTemporarilyUnavailable(error) ? 13 : 4;
        if (attempt >= maxAttempts) {
          throw error;
        }
        await (config.retryDelay ?? defaultRetryDelay)(attempt, error);
      }
    }
  }

  function load(
    target: CheckpointDiffTarget,
    client?: CheckpointDiffClient,
    options?: { readonly force?: boolean },
  ): Promise<CheckpointDiffResult | null> {
    const targetKey = getCheckpointDiffTargetKey(target);
    const decoded = decodeCheckpointDiffRequest(target);
    if (targetKey === null || target.environmentId === null || decoded._tag === "None") {
      return Promise.resolve(null);
    }

    if (!options?.force) {
      const current = config.getRegistry().get(checkpointDiffStateAtom(targetKey));
      if (current.data !== null && current.error === null) {
        return Promise.resolve(current.data);
      }
    }

    const existing = inFlight.get(targetKey);
    if (existing) {
      return existing;
    }

    const resolved = client ?? config.getClient(target.environmentId);
    if (!resolved) {
      setError(targetKey, new Error("Remote connection is not ready."));
      return Promise.resolve(config.getRegistry().get(checkpointDiffStateAtom(targetKey)).data);
    }

    markPending(targetKey);
    const version = getVersion(targetKey);
    const promise = requestWithRetry(resolved, decoded.value).then(
      (result) => {
        if (getVersion(targetKey) === version) {
          setState(targetKey, { data: result, error: null, isPending: false });
        }
        return result;
      },
      (error: unknown) => {
        if (getVersion(targetKey) === version) {
          setError(targetKey, error);
        }
        return config.getRegistry().get(checkpointDiffStateAtom(targetKey)).data;
      },
    );
    inFlight.set(targetKey, promise);
    void promise.finally(() => {
      if (inFlight.get(targetKey) === promise) {
        inFlight.delete(targetKey);
      }
    });
    return promise;
  }

  function getSnapshot(target: CheckpointDiffTarget): CheckpointDiffState {
    const targetKey = getCheckpointDiffTargetKey(target);
    return targetKey === null
      ? EMPTY_CHECKPOINT_DIFF_STATE
      : config.getRegistry().get(checkpointDiffStateAtom(targetKey));
  }

  function invalidate(target?: CheckpointDiffTarget): void {
    if (target) {
      const targetKey = getCheckpointDiffTargetKey(target);
      if (targetKey === null) {
        return;
      }
      bumpVersion(targetKey);
      inFlight.delete(targetKey);
      setState(targetKey, INITIAL_CHECKPOINT_DIFF_STATE);
      return;
    }

    for (const key of knownCheckpointDiffKeys) {
      bumpVersion(key);
      setState(key, INITIAL_CHECKPOINT_DIFF_STATE);
    }
    inFlight.clear();
  }

  return {
    getSnapshot,
    invalidate,
    load,
  };
}
