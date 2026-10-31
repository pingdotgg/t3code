import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PullRequestFilesViewedResult,
  PullRequestRef,
} from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  pullRequestEnvironment,
  subscribePullRequestFilesViewedAnswers,
} from "~/state/pullRequests";

import { toastManager } from "../ui/toast";
import {
  revertFileViewedOverlay,
  settleFileViewedOverlay,
  toFileViewedBatch,
  toFileViewedStates,
  type FileViewedOverlay,
  type FileViewedPress,
} from "./pullRequestFilesViewed.logic";

export interface FilesViewedTarget {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
}

type FilesViewedBatch = ReadonlyArray<{
  readonly path: string;
  readonly viewed: boolean;
  readonly revision?: string;
}>;

export interface FilesViewedStoreDeps {
  readonly flushDelayMs: number;
  /** Calls `onAnswer` only after completed server reads, excluding persisted values. */
  readonly subscribeAnswers: (
    target: FilesViewedTarget,
    onAnswer: (answer: PullRequestFilesViewedResult | null) => void,
  ) => () => void;
  readonly send: (
    target: FilesViewedTarget,
    batch: FilesViewedBatch,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly refresh: (target: FilesViewedTarget) => void;
  readonly reportFailure: () => void;
}

export interface FilesViewedScopeHandle {
  /** Holds the scope open while subscribed; the last reader to leave sends its last presses. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => FileViewedOverlay;
  readonly setViewed: (path: string, viewed: boolean, revision?: string) => void;
}

const NO_OVERLAY: FileViewedOverlay = new Map();

interface FilesViewedScope {
  readonly target: FilesViewedTarget;
  readonly listeners: Set<() => void>;
  readonly unsubscribeAnswers: () => void;
  overlay: FileViewedOverlay;
  queued: Map<string, FileViewedPress>;
  readonly sentBy: Map<string, number>;
  requests: number;
  timer: ReturnType<typeof setTimeout> | null;
  // Completed reads retire acknowledged presses even when equal data is structurally shared.
  readonly answeredFrom: Set<string>;
}

/**
 * Presses on one change request on one environment. The environment is part of the scope: two of
 * them can hand out the same project id, and a press made against one must never be answered for
 * by the other.
 */
export function createFilesViewedStore(deps: FilesViewedStoreDeps) {
  const scopes = new Map<string, FilesViewedScope>();
  const handles = new Map<string, FilesViewedScopeHandle>();

  const publish = (scope: FilesViewedScope, overlay: FileViewedOverlay) => {
    if (overlay === scope.overlay) return;
    scope.overlay = overlay;
    for (const listener of scope.listeners) listener();
  };

  const isLive = (key: string, scope: FilesViewedScope) => scopes.get(key) === scope;

  const settle = (scope: FilesViewedScope, answer: PullRequestFilesViewedResult | null) => {
    if (answer === null) return;
    const pending = new Set([...scope.queued.keys(), ...scope.sentBy.keys()]);
    const answered = new Set<string>();
    for (const path of scope.answeredFrom) {
      if (pending.has(path)) continue;
      answered.add(path);
      scope.answeredFrom.delete(path);
    }
    publish(
      scope,
      settleFileViewedOverlay(scope.overlay, toFileViewedStates(answer), pending, answered),
    );
  };

  const flush = (key: string, scope: FilesViewedScope) => {
    scope.timer = null;
    const batch = toFileViewedBatch(scope.queued);
    if (batch.length === 0) return;
    scope.queued = new Map();
    const request = ++scope.requests;
    for (const file of batch) scope.sentBy.set(file.path, request);
    void deps.send(scope.target, batch).then((result) => {
      const mine = batch
        .map((file) => file.path)
        .filter((path) => scope.sentBy.get(path) === request);
      for (const path of mine) scope.sentBy.delete(path);
      if (!isLive(key, scope)) {
        // The overlay this press stood in is gone, but the cached answer still predates the
        // write, and a reader coming back to this change request would be shown that.
        if (result._tag === "Success" || !isAtomCommandInterrupted(result)) {
          deps.refresh(scope.target);
        }
        return;
      }
      if (result._tag === "Failure") {
        const owned = new Set(mine.filter((path) => !scope.queued.has(path)));
        publish(scope, revertFileViewedOverlay(scope.overlay, batch, owned));
        if (owned.size > 0 && !isAtomCommandInterrupted(result)) {
          deps.reportFailure();
          deps.refresh(scope.target);
        }
        return;
      }
      // Answered for from the next read on, whatever it says. A push landing between the write
      // and that read comes back as `dismissed`, and the press must not stand over it.
      for (const path of mine) scope.answeredFrom.add(path);
      deps.refresh(scope.target);
    });
  };

  const acquire = (
    key: string,
    target: FilesViewedTarget,
    handle: FilesViewedScopeHandle,
    listener: () => void,
  ) => {
    // Registered from `subscribe`, which runs at commit, so a render that never commits leaves
    // nothing behind. Re-registering here also carries a handle across StrictMode's
    // subscribe-release-subscribe, so later renders keep returning it.
    if (!handles.has(key)) handles.set(key, handle);
    let scope = scopes.get(key);
    if (scope === undefined) {
      const listeners = new Set<() => void>();
      let created: FilesViewedScope | undefined;
      const unsubscribeAnswers = deps.subscribeAnswers(target, (answer) => {
        if (created !== undefined) settle(created, answer);
      });
      created = {
        target,
        listeners,
        unsubscribeAnswers,
        overlay: NO_OVERLAY,
        queued: new Map(),
        sentBy: new Map(),
        requests: 0,
        timer: null,
        answeredFrom: new Set(),
      };
      scope = created;
      scopes.set(key, scope);
    }
    const owned = scope;
    owned.listeners.add(listener);
    return () => {
      if (!owned.listeners.delete(listener) || owned.listeners.size > 0) return;
      // Leaving a change request, the environment it lives on, or the page itself records what
      // was pressed and then drops the rest, sending those last presses to the scope being left.
      if (owned.timer !== null) {
        clearTimeout(owned.timer);
        flush(key, owned);
      }
      scopes.delete(key);
      handles.delete(key);
      owned.unsubscribeAnswers();
    };
  };

  return {
    /**
     * One stable handle per open scope, so readers keep their subscription across renders. Pure
     * during render: an uncommitted handle is not cached, and any handle for a key behaves the same.
     */
    scope(target: FilesViewedTarget): FilesViewedScopeHandle {
      const key = filesViewedScopeKey(target);
      const cached = handles.get(key);
      if (cached !== undefined) return cached;
      const owned = { environmentId: target.environmentId, reference: { ...target.reference } };
      const handle: FilesViewedScopeHandle = {
        subscribe: (listener) => acquire(key, owned, handle, listener),
        getSnapshot: () => scopes.get(key)?.overlay ?? NO_OVERLAY,
        setViewed: (path, viewed, revision) => {
          const scope = scopes.get(key);
          if (scope === undefined) return;
          scope.queued.set(path, { viewed, revision });
          publish(scope, new Map(scope.overlay).set(path, viewed));
          if (scope.timer !== null) clearTimeout(scope.timer);
          scope.timer = setTimeout(() => flush(key, scope), deps.flushDelayMs);
        },
      };
      return handle;
    },
  };
}

function filesViewedScopeKey({ environmentId, reference }: FilesViewedTarget): string {
  return JSON.stringify([
    environmentId,
    reference.projectId,
    reference.host ?? null,
    reference.expectedAccountId ?? null,
    reference.allowStale ?? null,
    reference.repository,
    reference.number,
  ]);
}

const filesViewedAtom = ({ environmentId, reference }: FilesViewedTarget) =>
  pullRequestEnvironment.filesViewed({ environmentId, input: reference });

const filesViewedStore = createFilesViewedStore({
  flushDelayMs: 400,
  subscribeAnswers: ({ environmentId, reference }, onAnswer) =>
    subscribePullRequestFilesViewedAnswers({ environmentId, input: reference }, onAnswer),
  send: ({ environmentId, reference }, files) =>
    runAtomCommand(
      appAtomRegistry,
      pullRequestEnvironment.setFilesViewed,
      { environmentId, input: { ...reference, files } },
      { reportFailure: false },
    ),
  refresh: (target) => appAtomRegistry.refresh(filesViewedAtom(target)),
  reportFailure: () => toastManager.add({ type: "error", title: "Could not update viewed files" }),
});

export function filesViewedScope(target: FilesViewedTarget): FilesViewedScopeHandle {
  return filesViewedStore.scope(target);
}
