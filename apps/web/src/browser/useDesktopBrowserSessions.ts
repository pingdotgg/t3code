import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { isElectron } from "~/env";
import {
  applyPreviewServerEvent,
  reconcilePreviewEnvironmentSessions,
  resetPreviewServerEpoch,
} from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";

const inactiveAtom = Atom.make(() => undefined);
const desktopBrowserSessionsAtom = Atom.family((environmentId: EnvironmentId) => {
  const eventsAtom = previewEnvironment.events({ environmentId, input: {} });
  const sessionsAtom = previewEnvironment.list({ environmentId, input: {} });
  return Atom.make((get) => {
    let disposed = false;
    let serverEpoch: string | null = null;
    get.addFinalizer(() => {
      disposed = true;
    });
    const adoptServerEpoch = (nextEpoch: string) => {
      if (serverEpoch === nextEpoch) return;
      // Mounted chats have separate queries that must not finish from the retired server.
      for (const threadRef of resetPreviewServerEpoch(environmentId, nextEpoch)) {
        get.refresh(
          previewEnvironment.list({ environmentId, input: { threadId: threadRef.threadId } }),
        );
      }
      serverEpoch = nextEpoch;
    };
    get.subscribe(eventsAtom, (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      const event = result.value;
      if (serverEpoch !== event.serverEpoch) {
        adoptServerEpoch(event.serverEpoch);
        get.refresh(sessionsAtom);
      }
      applyPreviewServerEvent(scopeThreadRef(environmentId, ThreadId.make(event.threadId)), event);
    });
    // List queries re-run when the connection changes. Hydrate all existing tabs
    // as well as live events, including ones opened before the renderer attached.
    get.refresh(sessionsAtom);
    get.subscribe(
      sessionsAtom,
      (result) => {
        if (!AsyncResult.isSuccess(result) || result.waiting) return;
        adoptServerEpoch(result.value.serverEpoch);
        if (!reconcilePreviewEnvironmentSessions(environmentId, result.value)) {
          // An event may have arrived after the first list was read. Fetch a
          // complete baseline before considering that thread's index ready.
          queueMicrotask(() => {
            if (!disposed) get.refresh(sessionsAtom);
          });
        }
      },
      { immediate: true },
    );
  }).pipe(Atom.withLabel(`preview:desktop-host-sync:${environmentId}`));
});

/** The desktop hosts its server's tabs even while their chat views are unmounted. */
export function useDesktopBrowserSessions(environmentId: EnvironmentId | null): void {
  useAtomValue(
    isElectron && environmentId !== null ? desktopBrowserSessionsAtom(environmentId) : inactiveAtom,
  );
}
