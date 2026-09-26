"use client";

import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  applyPreviewServerEvent,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  recordPreviewListFailure,
} from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";

class PreviewSessionThreadKeyParseError extends Schema.TaggedError<PreviewSessionThreadKeyParseError>()(
  "PreviewSessionThreadKeyParseError",
  { threadKey: Schema.String },
) {
  override get message(): string {
    return `Invalid scoped preview thread key: ${this.threadKey}`;
  }
}

const previewSessionSyncAtom = Atom.family((threadKey: string) => {
  const threadRef = parseScopedThreadKey(threadKey);
  if (threadRef === null) {
    throw new PreviewSessionThreadKeyParseError({ threadKey });
  }

  const sessionsAtom = previewEnvironment.list({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  const eventsAtom = previewEnvironment.events({
    environmentId: threadRef.environmentId,
    input: {},
  });

  return Atom.make((get) => {
    let disposed = false;
    let eventsVersion = 0;

    const reconcileSessions = (result: Atom.Type<typeof sessionsAtom>) => {
      // A refresh re-emits the previous result with `waiting` while the
      // request is in flight — replayed data is not fresh authority for a
      // tab's absence, so only completed responses update the store: a
      // Success reconciles (advancing listSeq), a Failure records the
      // completed attempt (advancing listFailures) so arbitration waiters
      // can retry instead of hanging on a request that already resolved.
      if (result.waiting) return;
      if (AsyncResult.isSuccess(result)) {
        reconcilePreviewServerSessions(threadRef, result.value);
      } else if (AsyncResult.isFailure(result)) {
        recordPreviewListFailure(threadRef);
      }
    };

    const applyLatestEvent = (result: Atom.Type<typeof eventsAtom>) => {
      if (!AsyncResult.isSuccess(result) || result.value.threadId !== threadRef.threadId) return;
      const currentEpoch = readThreadPreviewState(threadRef).serverEpoch;
      if (currentEpoch !== null && currentEpoch !== result.value.serverEpoch) {
        get.refresh(sessionsAtom);
        return;
      }
      applyPreviewServerEvent(threadRef, result.value);
    };

    get.addFinalizer(() => {
      disposed = true;
    });
    const initialEvent = get.once(eventsAtom);
    // `get.subscribe` alone never evaluates a lazy query atom — read the
    // current result so `preview.list` actually runs; sessions that predate
    // this mount (restored views, extension surface leases) only surface here.
    reconcileSessions(get.once(sessionsAtom));
    get.subscribe(sessionsAtom, (result) => {
      reconcileSessions(result);
    });
    get.subscribe(eventsAtom, (result) => {
      eventsVersion += 1;
      applyLatestEvent(result);
    });
    queueMicrotask(() => {
      if (disposed) return;
      // The cached list can predate an automation-created tab. Keep the local
      // snapshot visible until an authoritative refresh arrives instead of
      // reconciling against a stale empty result when the panel first mounts.
      get.refresh(sessionsAtom);
      if (eventsVersion === 0) applyLatestEvent(initialEvent);
    });
  }).pipe(Atom.setIdleTTL(1_000), Atom.withLabel(`preview:session-sync:${threadKey}`));
});

export function usePreviewSession(threadRef: ScopedThreadRef): void {
  useAtomValue(previewSessionSyncAtom(scopedThreadKey(threadRef)));
}

/**
 * Non-React mount for hosts that must keep a thread's preview session index
 * live without rendering preview chrome (extension surface leases).
 * Returns the unmount function; the atom's own idle TTL still applies.
 */
export function mountPreviewSessionSync(threadRef: ScopedThreadRef): () => void {
  return appAtomRegistry.mount(previewSessionSyncAtom(scopedThreadKey(threadRef)));
}

/**
 * Force a fresh authoritative preview.list for the thread. Surface leases use
 * it to arbitrate absent sessions: a list that lands after this call proves a
 * missing tab is gone rather than merely unobserved.
 */
export function refreshPreviewSessionList(threadRef: ScopedThreadRef): void {
  appAtomRegistry.refresh(
    previewEnvironment.list({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
}
