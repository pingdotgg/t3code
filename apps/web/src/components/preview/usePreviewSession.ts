import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  applyPreviewServerEvent,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
} from "~/previewStateStore";
import { isElectron } from "~/env";
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
      if (result.waiting || !AsyncResult.isSuccess(result)) return;
      reconcilePreviewServerSessions(threadRef, result.value);
      if (!readThreadPreviewState(threadRef).listLoaded) {
        // An event overtook the initial list; retry before using the partial index for surface cleanup.
        queueMicrotask(() => {
          if (!disposed) get.refresh(sessionsAtom);
        });
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
    // Evaluate the lazy list, then reconcile only new responses because cached results can be stale.
    get.once(sessionsAtom);
    get.subscribe(sessionsAtom, (result) => {
      reconcileSessions(result);
    });
    get.subscribe(eventsAtom, (result) => {
      eventsVersion += 1;
      applyLatestEvent(result);
    });
    get.mount(sessionsAtom);
    get.mount(eventsAtom);
    queueMicrotask(() => {
      if (disposed) return;
      // Keep local tabs until authoritative refresh; stale cached emptiness could remove automation-created
      // tabs.
      const current = get.once(sessionsAtom);
      if (!AsyncResult.isInitial(current) && !current.waiting) get.refresh(sessionsAtom);
      if (eventsVersion === 0) applyLatestEvent(initialEvent);
    });
  }).pipe(Atom.setIdleTTL(1_000), Atom.withLabel(`preview:session-sync:${threadKey}`));
});

export function usePreviewSession(threadRef: ScopedThreadRef): void {
  useAtomValue(previewSessionSyncAtom(scopedThreadKey(threadRef)));
}

const inactiveAtom = Atom.make(() => undefined);

// Discover background tabs without listing every thread at startup. Retain each
// sync for the host's lifetime so later events still arrive while chat is absent.
const desktopHostedPreviewSyncAtom = Atom.family((environmentId: EnvironmentId) => {
  const eventsAtom = previewEnvironment.events({ environmentId, input: {} });
  return Atom.make((get) => {
    const syncedThreadIds = new Set<string>();
    get.subscribe(
      eventsAtom,
      (result) => {
        if (!AsyncResult.isSuccess(result) || result.value.type === "closed") return;
        const threadId = result.value.threadId;
        if (syncedThreadIds.has(threadId)) return;
        syncedThreadIds.add(threadId);
        get.mount(
          previewSessionSyncAtom(
            scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId))),
          ),
        );
      },
      { immediate: true },
    );
  }).pipe(Atom.withLabel(`preview:desktop-hosted-sync:${environmentId}`));
});

export function useDesktopHostedPreviewSessions(environmentId: EnvironmentId | null): void {
  useAtomValue(
    isElectron && environmentId !== null
      ? desktopHostedPreviewSyncAtom(environmentId)
      : inactiveAtom,
  );
}
