import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import type { EmbedSurface } from "../routes/embed.$environmentId.$threadId";
import { buildThreadRouteParams } from "../threadRoutes";

// Only the thread key is read, so the whole struct is not validated on every
// publish (the workspace entry updates on each git poll).
const hasThreadKey = Schema.is(Schema.Struct({ threadKey: Schema.String }));

/**
 * Mounted by the embed route in one of the shell's secondary web views.
 * Follows the thread the primary view publishes (`rightPanel` for the panel,
 * `workspace` for the terminal drawer) so the document shows the thread the
 * user is looking at, without the shell having to drive navigation.
 */
export function ShellEmbedRouteBridge({
  threadRef,
  surface,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly surface: EmbedSurface;
}) {
  const navigate = useNavigate();
  useEffect(() => {
    const shell = window.t3Shell;
    if (!shell) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void shell
      .onState((state) => {
        const entry = surface === "terminal" ? state.workspace : state.rightPanel;
        if (!hasThreadKey(entry)) return;
        const target = parseScopedThreadKey(entry.threadKey);
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
          search: { surface },
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
  }, [navigate, surface, threadRef.environmentId, threadRef.threadId]);
  return null;
}
