import { parseScopedThreadKey, scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { retainThreadDetailSubscription } from "../environments/runtime/service";
import type { SidebarThreadSummary } from "../types";
import {
  createSidebarHoverPrewarmController,
  SIDEBAR_THREAD_HOVER_PREWARM_DELAY_MS,
} from "./Sidebar.logic";

export function getSidebarThreadPrewarmKey(
  thread: Pick<SidebarThreadSummary, "environmentId" | "id" | "virtualAgentRun">,
): string {
  return scopedThreadKey(
    scopeThreadRef(thread.environmentId, thread.virtualAgentRun?.parentThreadId ?? thread.id),
  );
}

function SidebarThreadDetailPrewarmer({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useEffect(
    () => retainThreadDetailSubscription(threadRef.environmentId, threadRef.threadId),
    [threadRef.environmentId, threadRef.threadId],
  );
  return null;
}

export function SidebarHoverThreadPrewarmer() {
  const [threadKey, setThreadKey] = useState<string | null>(null);

  useEffect(() => {
    const controller = createSidebarHoverPrewarmController({
      delayMs: SIDEBAR_THREAD_HOVER_PREWARM_DELAY_MS,
      onPrewarmTargetChange: setThreadKey,
    });
    const onPointerOver = (event: globalThis.PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      controller.hover(
        target?.closest("[data-thread-prewarm-key]")?.getAttribute("data-thread-prewarm-key") ??
          null,
      );
    };
    window.addEventListener("pointerover", onPointerOver, { passive: true });
    return () => {
      window.removeEventListener("pointerover", onPointerOver);
      controller.dispose();
    };
  }, []);

  const threadRef = useMemo(
    () => (threadKey === null ? null : parseScopedThreadKey(threadKey)),
    [threadKey],
  );
  return threadRef ? <SidebarThreadDetailPrewarmer threadRef={threadRef} /> : null;
}
