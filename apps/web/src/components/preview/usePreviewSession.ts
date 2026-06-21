"use client";

import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  applyPreviewServerEvent,
  applyPreviewServerSnapshot,
  readThreadPreviewState,
} from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";

const previewSessionSyncAtom = Atom.family((threadKey: string) => {
  const threadRef = parseScopedThreadKey(threadKey);
  if (!threadRef) {
    throw new Error(`Invalid scoped preview thread key: ${threadKey}`);
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
    let recoveryId = 0;
    let recoveringUrl: string | null = null;
    let sessionsVersion = 0;
    let eventsVersion = 0;

    const reconcileSessions = (result: Atom.Type<typeof sessionsAtom>) => {
      if (!AsyncResult.isSuccess(result)) return;
      if (result.value.sessions.length > 0) {
        recoveringUrl = null;
        recoveryId += 1;
        for (const snapshot of result.value.sessions) {
          applyPreviewServerSnapshot(threadRef, snapshot);
        }
        return;
      }

      const localSnapshot = readThreadPreviewState(threadRef).snapshot;
      const recoverableUrl =
        localSnapshot && localSnapshot.navStatus._tag !== "Idle"
          ? localSnapshot.navStatus.url
          : null;
      if (!recoverableUrl) {
        applyPreviewServerSnapshot(threadRef, null);
        return;
      }
      if (recoveringUrl === recoverableUrl) return;

      recoveringUrl = recoverableUrl;
      const currentRecoveryId = ++recoveryId;
      void runAtomCommand(
        get.registry,
        previewEnvironment.open,
        {
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, url: recoverableUrl },
        },
        { reportDefect: false, reportFailure: false },
      ).then((openResult) => {
        if (disposed || currentRecoveryId !== recoveryId) return;
        recoveringUrl = null;
        if (openResult._tag === "Failure") return;
        applyPreviewServerSnapshot(threadRef, openResult.value);
        get.refresh(sessionsAtom);
      });
    };

    const applyLatestEvent = (result: Atom.Type<typeof eventsAtom>) => {
      if (!AsyncResult.isSuccess(result) || result.value.threadId !== threadRef.threadId) return;
      applyPreviewServerEvent(threadRef, result.value);
      if (result.value.type === "opened" || result.value.type === "closed") {
        get.refresh(sessionsAtom);
      }
    };

    get.addFinalizer(() => {
      disposed = true;
      recoveryId += 1;
    });
    const initialSessions = get.once(sessionsAtom);
    const initialEvent = get.once(eventsAtom);
    get.subscribe(sessionsAtom, (result) => {
      sessionsVersion += 1;
      reconcileSessions(result);
    });
    get.subscribe(eventsAtom, (result) => {
      eventsVersion += 1;
      applyLatestEvent(result);
    });
    queueMicrotask(() => {
      if (disposed) return;
      if (sessionsVersion === 0) reconcileSessions(initialSessions);
      if (eventsVersion === 0) applyLatestEvent(initialEvent);
    });
  }).pipe(Atom.setIdleTTL(1_000), Atom.withLabel(`preview:session-sync:${threadKey}`));
});

export function usePreviewSession(threadRef: ScopedThreadRef): void {
  useAtomValue(previewSessionSyncAtom(scopedThreadKey(threadRef)));
}
