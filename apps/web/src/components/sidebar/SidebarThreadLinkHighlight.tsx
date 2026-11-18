import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { observeResize } from "../../lib/observeResize";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { readThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { sidebarFolderRowId } from "./SidebarProjectFolderHeader";

export function SidebarThreadLinkHighlight({
  containerRef,
  dragging,
  projectGroups,
}: {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly dragging: boolean;
  readonly projectGroups: readonly SidebarProjectSnapshot[];
}) {
  const [threadKey, setThreadKey] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to delegated sidebar pointer and focus events.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setThreadKey(null);
    let activeKey: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const select = (target: EventTarget | null) => {
      const row =
        !dragging && target instanceof Element ? target.closest("[data-sidebar-thread]") : null;
      const nextKey = row && container.contains(row) ? row.getAttribute("data-sidebar-row") : null;
      if (nextKey === activeKey) return;
      activeKey = nextKey;
      clearTimeout(timer);
      setThreadKey(null);
      if (nextKey !== null) timer = setTimeout(() => setThreadKey(nextKey), 150);
    };
    const onOver = (event: PointerEvent) => select(event.buttons === 0 ? event.target : null);
    const onFocus = (event: FocusEvent) => select(event.target);
    const onLeave = () => select(null);
    const onFocusOut = (event: FocusEvent) => select(event.relatedTarget);
    container.addEventListener("pointerover", onOver);
    container.addEventListener("pointerleave", onLeave);
    container.addEventListener("pointerdown", onLeave, true);
    container.addEventListener("focusin", onFocus);
    container.addEventListener("focusout", onFocusOut);
    return () => {
      clearTimeout(timer);
      container.removeEventListener("pointerover", onOver);
      container.removeEventListener("pointerleave", onLeave);
      container.removeEventListener("pointerdown", onLeave, true);
      container.removeEventListener("focusin", onFocus);
      container.removeEventListener("focusout", onFocusOut);
    };
  }, [containerRef, dragging]);

  const thread = dragging || threadKey === null ? null : parseScopedThreadKey(threadKey);
  const mentionLinks = useEnvironmentQuery(
    thread === null
      ? null
      : orchestrationEnvironment.threadMentionLinks({
          environmentId: thread.environmentId,
          input: { threadId: thread.threadId },
        }),
  );
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const [geometry, setGeometry] = useState<{
    x: number;
    sourceY: number;
    targets: { key: string; y: number; controlX: number; collapsed: boolean }[];
  } | null>(null);
  const links = mentionLinks.data?.links;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measure sidebar DOM positions and subscribe to content resizing while a row is active.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    if (!container || !overlay || !threadKey || !thread || !links?.length) return;
    const measure = () => {
      const origin = overlay.getBoundingClientRect();
      const findRow = (key: string) =>
        container.querySelector<HTMLElement>(`[data-sidebar-row="${CSS.escape(key)}"]`);
      const source = findRow(threadKey);
      if (!source || source.getBoundingClientRect().height === 0) {
        setGeometry(null);
        return;
      }
      const rows = [...container.querySelectorAll<HTMLElement>("[data-sidebar-row]")].filter(
        (row) => row.getBoundingClientRect().height > 0,
      );
      const contentLeft = Math.min(
        ...rows.map((row) => {
          const content = row.matches("[data-sidebar-row-content]")
            ? row
            : (row.querySelector<HTMLElement>("[data-sidebar-row-content]") ?? row);
          return (
            content.getBoundingClientRect().left +
            Number.parseFloat(getComputedStyle(content).paddingLeft) -
            origin.left
          );
        }),
      );
      const x = contentLeft - 4.5;
      if (x <= 4.5) {
        setGeometry(null);
        return;
      }
      const sourceRect = source.getBoundingClientRect();
      const sourceY = sourceRect.top + sourceRect.height / 2 - origin.top;
      const targets = [...new Set(links.map((link) => link.threadId))].flatMap((threadId) => {
        const ref = { environmentId: thread.environmentId, threadId };
        const key = scopedThreadKey(ref);
        if (key === threadKey) return [];
        let row = findRow(key);
        const collapsed = row === null;
        if (collapsed) {
          const shell = readThreadShell(ref);
          if (!shell || effectiveSnoozed(shell, { now: new Date().toISOString() })) return [];
          if (shell.settledOverride === "settled") {
            row = findRow("shelf:settled");
          } else if (shell.pinnedAt == null) {
            const group = projectGroups.find((group) =>
              group.memberProjectRefs.some(
                (project) =>
                  project.environmentId === ref.environmentId &&
                  project.projectId === shell.projectId,
              ),
            );
            if (group) row = findRow(sidebarFolderRowId(group.projectKey));
          }
          if (row?.getAttribute("aria-expanded") !== "false") return [];
        }
        if (!row) return [];
        const rect = row.getBoundingClientRect();
        return rect.height > 0
          ? [{ key, y: rect.top + rect.height / 2 - origin.top, collapsed }]
          : [];
      });
      targets.sort((a, b) => Math.abs(a.y - sourceY) - Math.abs(b.y - sourceY));
      setGeometry({
        x,
        sourceY,
        targets: targets.map((target, index) => ({
          ...target,
          controlX: x - (x - 2) * ((index + 1) / targets.length),
        })),
      });
    };
    let frame: number | undefined;
    const scheduleMeasure = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        measure();
      });
    };
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => !overlay.contains(record.target))) scheduleMeasure();
    });
    mutations.observe(container, { childList: true, subtree: true });
    const stopObservingResize = observeResize(container, scheduleMeasure);
    measure();
    return () => {
      mutations.disconnect();
      stopObservingResize();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [containerRef, threadKey, thread, links, projectGroups]);

  return (
    <svg
      ref={overlayRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-30 h-full w-full overflow-hidden"
    >
      {thread !== null && links?.length && geometry?.targets.length ? (
        <g stroke="var(--color-orange-500)" strokeWidth={1.75} fill="var(--color-orange-500)">
          {geometry.targets.map((target) => (
            <g key={target.key}>
              <path
                d={`M ${geometry.x} ${geometry.sourceY} C ${target.controlX} ${geometry.sourceY}, ${target.controlX} ${target.y}, ${geometry.x} ${target.y}`}
                fill="none"
                strokeDasharray={target.collapsed ? "4 3" : undefined}
              />
              <circle
                cx={geometry.x}
                cy={target.y}
                r={2.5}
                fill={target.collapsed ? "none" : undefined}
                stroke={target.collapsed ? undefined : "none"}
              />
            </g>
          ))}
          <circle cx={geometry.x} cy={geometry.sourceY} r={2.5} stroke="none" />
        </g>
      ) : null}
    </svg>
  );
}
