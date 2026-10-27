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
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { pullRequestEnvironment } from "~/state/pullRequests";

import { toastManager } from "../ui/toast";
import {
  revertFileViewedOverlay,
  settleFileViewedOverlay,
  toFileViewedBatch,
  toFileViewedStates,
  type FileViewedOverlay,
} from "./pullRequestFilesViewed.logic";

export interface FilesViewedTarget {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
}

type FilesViewedBatch = ReadonlyArray<{ readonly path: string; readonly viewed: boolean }>;

export interface FilesViewedStoreDeps {
  readonly flushDelayMs: number;
  /** Calls `onAnswer` with the host's current answer at once, then with every later one. */
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
  readonly setViewed: (path: string, viewed: boolean) => void;
}

const NO_OVERLAY: FileViewedOverlay = new Map();

interface FilesViewedScope {
  readonly target: FilesViewedTarget;
  readonly listeners: Set<() => void>;
  readonly unsubscribeAnswers: () => void;
  overlay: FileViewedOverlay;
  queued: Map<string, boolean>;
  readonly sentBy: Map<string, number>;
  requests: number;
  timer: ReturnType<typeof setTimeout> | null;
  answer: PullRequestFilesViewedResult | null;
  /**
   * The host's answer as it stood when a completed write was acknowledged, per path. The first
   * answer that differs from it is the first read that could have seen the write, which is what
   * retires the press rather than the host happening to agree with it.
   */
  readonly answeredFrom: Map<string, PullRequestFilesViewedResult | null>;
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
    if (answer === scope.answer) return;
    scope.answer = answer;
    const pending = new Set([...scope.queued.keys(), ...scope.sentBy.keys()]);
    const answered = new Set<string>();
    for (const [path, from] of scope.answeredFrom) {
      if (pending.has(path) || from === answer) continue;
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
      for (const path of mine) scope.answeredFrom.set(path, scope.answer);
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
      let initial: PullRequestFilesViewedResult | null = null;
      const unsubscribeAnswers = deps.subscribeAnswers(target, (answer) => {
        if (created === undefined) initial = answer;
        else settle(created, answer);
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
        answer: initial,
        answeredFrom: new Map(),
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
        setViewed: (path, viewed) => {
          const scope = scopes.get(key);
          if (scope === undefined) return;
          scope.queued.set(path, viewed);
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
  subscribeAnswers: (target, onAnswer) =>
    appAtomRegistry.subscribe(
      filesViewedAtom(target),
      (result) => onAnswer(Option.getOrNull(AsyncResult.value(result))),
      { immediate: true },
    ),
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
