import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createLinkedThreadSession,
  type LinkedThreadOpen,
  type LinkedThreadTarget,
  resolveLinkedThreadOpen,
} from "@t3tools/client-runtime/linked-thread";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState, useSyncExternalStore } from "react";

import { useRightPanelStore } from "../rightPanelStore";
import { useStableCallback } from "../hooks/useStableCallback";
import { buildThreadRouteParams } from "../threadRoutes";
import { useEnvironment } from "./environments";
import { peerLinkEnvironment, useLinkedEnvironments } from "./peerLinks";
import { useAtomCommand } from "./use-atom-command";

/**
 * How a click opens a thread that the thread `panelRef` says is on a linked environment: in place
 * when this client is connected there itself, else as a read-only tab in that thread's right
 * panel, read through its environment. Once the link is gone a saved environment opens in place,
 * where the client can reconnect to it; with neither, the tab says what to link again.
 */
export function useLinkedThreadOpener(
  panelRef: ScopedThreadRef,
  thread:
    | {
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId;
        readonly label: string;
      }
    | undefined,
  title: string | null,
): { readonly mode: Exclude<LinkedThreadOpen, "unavailable">; readonly open: () => void } | null {
  const navigate = useNavigate();
  const viaEnvironmentId = panelRef.environmentId;
  const own = useEnvironment(thread?.environmentId ?? null);
  const connected = own?.connection.phase === "connected";
  const links = useLinkedEnvironments(thread === undefined || connected ? null : viaEnvironmentId);
  if (thread === undefined) return null;
  const resolved = resolveLinkedThreadOpen({
    environmentId: thread.environmentId,
    viaEnvironmentId,
    own: own === null ? undefined : { connected },
    linked: links.has(thread.environmentId),
  });
  const mode = resolved === "direct" ? "direct" : "linked";
  return {
    mode,
    open: () => {
      if (mode === "linked") {
        useRightPanelStore.getState().openLinkedThread(panelRef, {
          viaEnvironmentId,
          environmentId: thread.environmentId,
          threadId: thread.threadId,
          label: own?.label ?? thread.label,
          title,
        });
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.threadId)),
      });
    },
  };
}

/**
 * The transcript of `target`, read through the environment that links to it. Reads start when the
 * calling view mounts and stop when it unmounts; key the view by its target.
 */
export function useLinkedThreadSession(
  target: Pick<LinkedThreadTarget, "viaEnvironmentId" | "environmentId" | "threadId">,
  options: {
    /** Whether the view is being looked at; reads wait while it is not. */
    readonly isActive: () => boolean;
    /** The thread's own title, each time a read names it. */
    readonly onTitle: (title: string) => void;
  },
) {
  const onTitle = useStableCallback(options.onTitle);
  const read = useAtomCommand(peerLinkEnvironment.readThread, {
    reportFailure: false,
    reportDefect: false,
  });
  const [session] = useState(() =>
    createLinkedThreadSession({
      read: async (cursor) => {
        const result = await read({
          environmentId: target.viaEnvironmentId,
          input: { environmentId: target.environmentId, threadId: target.threadId, ...cursor },
        });
        if (result._tag !== "Success")
          return { ok: false, error: squashAtomCommandFailure(result) };
        if (result.value.thread.title) onTitle(result.value.thread.title);
        return { ok: true, page: result.value };
      },
      schedule: (run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      },
      isActive: options.isActive,
    }),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { state, session };
}
