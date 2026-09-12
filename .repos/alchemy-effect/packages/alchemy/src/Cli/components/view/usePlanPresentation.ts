import {
  measureElement,
  useProgress,
  useTitle,
  type DOMElement,
} from "@alchemy.run/sigil";
import { useLayoutEffect, useRef, useState } from "react";
import { useTerminalSize } from "../ui/index.ts";
import type { PlanTree, PlanTreeState } from "./PlanTree.ts";

export const usePlanPresentation = (options: {
  readonly tree: PlanTree;
  readonly state: PlanTreeState;
  readonly busy: boolean;
  readonly collapsible: boolean;
  readonly hasFooter: boolean;
}) => {
  const { tree, state, busy, collapsible, hasFooter } = options;
  const { mode } = tree;
  const { label, expanded, viewport, outcome } = state;
  const { completed, failures, total } = tree.progress();
  const collapsed = collapsible && !expanded;
  const settled = !busy && completed >= total;

  useProgress(
    mode === "apply"
      ? {
          state:
            outcome === "failure" || failures > 0
              ? "error"
              : busy
                ? "normal"
                : "inactive",
          value: total === 0 ? undefined : (completed / total) * 100,
        }
      : { state: "inactive" },
  );
  const titleProgress = settled || total === 0 ? "" : ` ${completed}/${total}`;
  const titleDetail = tree.titleDetail ? ` · ${tree.titleDetail}` : "";
  useTitle(
    mode === "apply" ? `${label}${titleProgress}${titleDetail}` : undefined,
  );

  const beforeRef = useRef<DOMElement>(null);
  const summaryRef = useRef<DOMElement>(null);
  const controlsRef = useRef<DOMElement>(null);
  const afterRef = useRef<DOMElement>(null);
  const [chromeRows, setChromeRows] = useState<number>();
  const { rows: terminalRows } = useTerminalSize();
  const showControls =
    mode === "apply" || (!collapsed && (collapsible || hasFooter));

  useLayoutEffect(() => {
    if (collapsed || viewport !== "virtual") return;
    const height = (ref: { readonly current: DOMElement | null }) =>
      ref.current === null ? 0 : measureElement(ref.current).height;
    const measured =
      height(beforeRef) +
      height(summaryRef) +
      height(controlsRef) +
      height(afterRef) +
      1 +
      (showControls ? 1 : 0);
    setChromeRows((current) => (current === measured ? current : measured));
  });

  const lineBudget =
    viewport === "virtual"
      ? Math.max(
          1,
          terminalRows - (mode === "apply" ? 3 : 0) - (chromeRows ?? 8),
        )
      : Number.POSITIVE_INFINITY;

  return {
    progress: { completed, failures, total },
    collapsed,
    showControls,
    lineBudget,
    refs: { beforeRef, summaryRef, controlsRef, afterRef },
  } as const;
};
