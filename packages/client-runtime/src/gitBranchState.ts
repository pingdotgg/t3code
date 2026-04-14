import type { GitBranch, GitListBranchesInput, GitListBranchesResult } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { WsRpcClient } from "./wsRpcClient";

export interface GitBranchTarget {
  readonly environmentId: string | null;
  readonly cwd: string | null;
  readonly query?: string | null;
}

export interface GitBranchState {
  readonly data: GitListBranchesResult | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

export type GitBranchClient = Pick<WsRpcClient["git"], "listBranches">;

export const EMPTY_GIT_BRANCH_STATE = Object.freeze<GitBranchState>({
  data: null,
  isPending: false,
  error: null,
});

const INITIAL_GIT_BRANCH_STATE = Object.freeze<GitBranchState>({
  data: null,
  isPending: true,
  error: null,
});

const knownGitBranchKeys = new Set<string>();

export const gitBranchStateAtom = Atom.family((key: string) => {
  knownGitBranchKeys.add(key);
  return Atom.make(EMPTY_GIT_BRANCH_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`git-branches:${key}`),
  );
});

export const EMPTY_GIT_BRANCH_ATOM = Atom.make(EMPTY_GIT_BRANCH_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("git-branches:null"),
);

function normalizeQuery(query: string | null | undefined): string {
  return query?.trim() ?? "";
}

export function getGitBranchTargetKey(target: GitBranchTarget): string | null {
  if (target.environmentId === null || target.cwd === null) {
    return null;
  }

  return `${target.environmentId}:${target.cwd}:${normalizeQuery(target.query)}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to load branches.";
}

function mergeBranches(
  previous: ReadonlyArray<GitBranch>,
  next: ReadonlyArray<GitBranch>,
): ReadonlyArray<GitBranch> {
  const merged = new Map<string, GitBranch>();
  for (const branch of previous) {
    merged.set(branch.name, branch);
  }
  for (const branch of next) {
    merged.set(branch.name, branch);
  }
  return [...merged.values()];
}

export interface GitBranchManagerConfig {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly getClient: (environmentId: string) => GitBranchClient | null;
}

export function createGitBranchManager(config: GitBranchManagerConfig) {
  const inFlight = new Map<string, Promise<GitListBranchesResult | null>>();

  function getSnapshot(target: GitBranchTarget): GitBranchState {
    const targetKey = getGitBranchTargetKey(target);
    if (targetKey === null) {
      return EMPTY_GIT_BRANCH_STATE;
    }
    return config.getRegistry().get(gitBranchStateAtom(targetKey));
  }

  function setState(targetKey: string, nextState: GitBranchState): void {
    config.getRegistry().set(gitBranchStateAtom(targetKey), nextState);
  }

  function markPending(targetKey: string): void {
    const current = config.getRegistry().get(gitBranchStateAtom(targetKey));
    setState(
      targetKey,
      current.data === null
        ? INITIAL_GIT_BRANCH_STATE
        : { ...current, isPending: true, error: null },
    );
  }

  function setData(targetKey: string, data: GitListBranchesResult): void {
    setState(targetKey, {
      data,
      isPending: false,
      error: null,
    });
  }

  function setError(targetKey: string, error: unknown): void {
    const current = config.getRegistry().get(gitBranchStateAtom(targetKey));
    setState(targetKey, {
      data: current.data,
      isPending: false,
      error: toErrorMessage(error),
    });
  }

  async function load(
    target: GitBranchTarget,
    client?: GitBranchClient,
    options?: {
      readonly cursor?: number;
      readonly limit?: number;
      readonly append?: boolean;
    },
  ): Promise<GitListBranchesResult | null> {
    const targetKey = getGitBranchTargetKey(target);
    if (targetKey === null || target.environmentId === null || target.cwd === null) {
      return null;
    }

    const resolved = client ?? config.getClient(target.environmentId);
    if (!resolved) {
      return getSnapshot(target).data;
    }

    const inFlightKey = `${targetKey}:${options?.cursor ?? "start"}:${options?.append ? "append" : "replace"}`;
    const existing = inFlight.get(inFlightKey);
    if (existing) {
      return existing;
    }

    markPending(targetKey);

    const current = getSnapshot(target).data;
    const request: GitListBranchesInput = {
      cwd: target.cwd,
      ...(normalizeQuery(target.query).length > 0 ? { query: normalizeQuery(target.query) } : {}),
      ...(options?.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    };

    const promise = resolved.listBranches(request).then(
      (result) => {
        const nextData =
          options?.append && current
            ? {
                ...result,
                branches: mergeBranches(current.branches, result.branches),
              }
            : result;
        setData(targetKey, nextData);
        return nextData;
      },
      (error) => {
        setError(targetKey, error);
        throw error;
      },
    );

    inFlight.set(inFlightKey, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(inFlightKey);
    }
  }

  async function loadNext(
    target: GitBranchTarget,
    client?: GitBranchClient,
    options?: { readonly limit?: number },
  ): Promise<GitListBranchesResult | null> {
    const current = getSnapshot(target).data;
    if (!current?.nextCursor && current?.nextCursor !== 0) {
      return current ?? null;
    }

    return load(target, client, {
      cursor: current.nextCursor,
      append: true,
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    });
  }

  function invalidate(target?: GitBranchTarget): void {
    if (target) {
      const targetKey = getGitBranchTargetKey(target);
      if (targetKey !== null) {
        setState(targetKey, EMPTY_GIT_BRANCH_STATE);
      }
      return;
    }

    for (const key of knownGitBranchKeys) {
      setState(key, EMPTY_GIT_BRANCH_STATE);
    }
  }

  function reset(): void {
    invalidate();
  }

  return {
    getSnapshot,
    load,
    loadNext,
    invalidate,
    reset,
  };
}
