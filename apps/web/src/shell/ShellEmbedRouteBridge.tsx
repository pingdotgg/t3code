import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ShellRightPanelState } from "@t3tools/contracts/shell";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { buildThreadRouteParams } from "../threadRoutes";

const isRightPanelState = Schema.is(ShellRightPanelState);

/**
 * Mounted by the embed route in the shell's secondary web view. Follows the
 * `rightPanel` state the primary view publishes so the panel shows the thread
 * the user is looking at, without the shell having to drive navigation.
 */
export function ShellEmbedRouteBridge({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  useEffect(() => {
    const shell = window.t3Shell;
    if (!shell) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void shell
      .onState((state) => {
        if (!isRightPanelState(state.rightPanel)) return;
        const target = parseScopedThreadKey(state.rightPanel.threadKey);
        if (
          target === null ||
          (target.environmentId === threadRef.environmentId &&
            target.threadId === threadRef.threadId)
        ) {
          return;
        }
        void navigate({
          to: "/embed/$environmentId/$threadId",
          params: buildThreadRouteParams(target),
          replace: true,
        });
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unsubscribe = dispose;
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [navigate, threadRef.environmentId, threadRef.threadId]);
  return null;
}
