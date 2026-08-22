import { getClientRect } from "@dnd-kit/core";
import { useLayoutEffect, useState, type RefObject } from "react";

import { moveSidebarDndBoardThread, type SidebarDndBoardEntry } from "../Sidebar.dnd.board";
import type { SidebarDndSection, SidebarThreadDropTarget } from "../Sidebar.dnd.logic";

interface OutlineGeometry {
  readonly top: number;
  readonly height: number;
}

export function SidebarThreadDropOutline(props: {
  section: "snoozed" | "settled";
  sourceSection: SidebarDndSection;
  sourceThreadKey: string;
  entries: readonly SidebarDndBoardEntry[];
  target: SidebarThreadDropTarget;
  presentationHeight: number;
  listRef: RefObject<HTMLUListElement | null>;
  getEntryNode: (id: string) => HTMLElement | null;
}) {
  const {
    entries,
    getEntryNode,
    listRef,
    presentationHeight,
    section,
    sourceSection,
    sourceThreadKey,
    target,
  } = props;
  const [geometry, setGeometry] = useState<OutlineGeometry | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;

    const sectionEntryIds: string[] = [];
    let inSection = false;
    for (const entry of entries) {
      if (entry.kind === "boundary") {
        if (inSection) break;
        if (entry.section !== section) continue;
        inSection = true;
      }
      if (inSection) sectionEntryIds.push(entry.id);
    }

    const measureEntry = (id: string) => {
      const node = getEntryNode(id);
      if (node === null) return null;
      const rect = getClientRect(node, { ignoreTransform: true });
      const translateY =
        sourceSection === section || node.style.transform.length === 0
          ? 0
          : new DOMMatrixReadOnly(node.style.transform).m42;
      return { top: rect.top + translateY, bottom: rect.bottom + translateY };
    };

    const firstRect = measureEntry(sectionEntryIds[0] ?? "");
    if (firstRect === null) {
      setGeometry(null);
      return;
    }

    let bottom = firstRect.bottom;
    for (const id of sectionEntryIds.slice(1)) {
      const rect = measureEntry(id);
      if (rect !== null) bottom = Math.max(bottom, rect.bottom);
    }

    if (sourceSection !== section) {
      const projectedEntries = moveSidebarDndBoardThread({
        entries,
        threadKey: sourceThreadKey,
        target,
      });
      const activeIndex = projectedEntries.findIndex((entry) => entry.id === sourceThreadKey);
      const nextEntry = projectedEntries[activeIndex + 1];
      if (activeIndex >= 1 && (nextEntry === undefined || nextEntry.kind === "boundary")) {
        const previousEntry = projectedEntries[activeIndex - 1];
        const previousRect = previousEntry === undefined ? null : measureEntry(previousEntry.id);
        if (previousRect !== null) {
          bottom = Math.max(bottom, previousRect.bottom + 1 + presentationHeight);
        }
      }
    }

    const listRect = getClientRect(list, { ignoreTransform: true });
    const nextGeometry = {
      top: firstRect.top - listRect.top,
      height: bottom - firstRect.top,
    };
    setGeometry((current) =>
      current !== null &&
      Math.abs(current.top - nextGeometry.top) < 0.5 &&
      Math.abs(current.height - nextGeometry.height) < 0.5
        ? current
        : nextGeometry,
    );
  }, [
    entries,
    getEntryNode,
    listRef,
    presentationHeight,
    section,
    sourceSection,
    sourceThreadKey,
    target,
  ]);

  if (geometry === null) return null;

  return (
    <li
      aria-hidden
      className="pointer-events-none absolute inset-x-1 z-30 list-none rounded-lg outline outline-1 -outline-offset-1 outline-ring/50"
      style={{
        height: geometry.height,
        transform: `translateY(${geometry.top}px)`,
        transition: "height 200ms ease, transform 200ms ease",
      }}
    />
  );
}
