import { useMemo, useState } from "react";
import { useTerminalInput } from "../ui/index.ts";
import { stackOutputLineCount } from "./StackOutputs.tsx";
import {
  type PlanRow,
  type PlanTree,
  type PlanTreeState,
  type PlanView,
} from "./PlanTree.ts";
import { isTerminalStatus } from "./statusStyle.ts";

export type VirtualPlanLine =
  | { readonly kind: "row"; readonly row: PlanRow }
  | {
      readonly kind: "yaml";
      readonly key: string;
      readonly line: string;
      readonly paddingLeft: number;
    }
  | {
      readonly kind: "note";
      readonly key: string;
      readonly paddingLeft: number;
    };

const planLines = (
  rows: readonly PlanRow[],
  detailed: boolean,
): VirtualPlanLine[] =>
  rows.flatMap((row): VirtualPlanLine[] => {
    const lines: VirtualPlanLine[] = [{ kind: "row", row }];
    if (row.type !== "resource") return lines;
    const showYaml = detailed || row.propertyYaml?.kind === "drift";
    if (!showYaml) return lines;
    if (row.propertyYaml !== undefined) {
      lines.push(
        ...row.propertyYaml.lines.map((line, index) => ({
          kind: "yaml" as const,
          key: `${row.key}:yaml:${index}`,
          line,
          paddingLeft: row.depth * 2 + 2,
        })),
      );
    } else if (
      row.action === "update" ||
      row.action === "adopted" ||
      row.action === "replace"
    ) {
      lines.push({
        kind: "note",
        key: `${row.key}:note`,
        paddingLeft: row.depth * 2 + 2,
      });
    }
    return lines;
  });

export interface PlanWindow {
  readonly selectedView: PlanView;
  readonly hasOutput: boolean;
  readonly virtual: boolean;
  readonly budget: number;
  readonly offset: number;
  readonly hiddenBelow: number;
  readonly planLines: readonly VirtualPlanLine[] | undefined;
}

export const usePlanViewport = (options: {
  readonly tree: PlanTree;
  readonly state: PlanTreeState;
  readonly lineBudget: number;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
}): PlanWindow => {
  const { tree, state, lineBudget, collapsible, collapsed } = options;
  const { rows, detailed } = tree;
  const { tasks, output, view, viewport } = state;
  const hasOutput = output !== undefined;
  const selectedView = view === "output" && hasOutput ? "output" : "plan";
  const virtual = viewport === "virtual";
  const expandedLines = useMemo(
    () => planLines(rows, detailed),
    [rows, detailed],
  );
  const available =
    lineBudget === Number.POSITIVE_INFINITY
      ? rows.length
      : Math.max(1, Math.floor(lineBudget));
  const length =
    selectedView === "output"
      ? stackOutputLineCount(output)
      : virtual
        ? expandedLines.length
        : rows.length;
  // Overflow markers render above and below the content window, so they must
  // consume its budget rather than extending the complete widget. Reserve
  // both even when following the end (where only the upper marker is shown),
  // because manual scrolling can make both visible without changing height.
  const budget =
    virtual && length > available ? Math.max(1, available - 2) : available;
  const maxOffset = Math.max(0, length - budget);
  const activeRow = tree.progressRows.find((row) => {
    const status = tasks.get(row.key)?.status;
    return status !== undefined && !isTerminalStatus(status);
  });
  const activeRowIndex = activeRow === undefined ? -1 : rows.indexOf(activeRow);
  const activeLineIndex = virtual
    ? expandedLines.findIndex(
        (line) => line.kind === "row" && line.row === rows[activeRowIndex],
      )
    : activeRowIndex;
  const followedOffset =
    selectedView === "output"
      ? maxOffset
      : Math.min(
          maxOffset,
          Math.max(
            0,
            (activeLineIndex < 0 ? length : activeLineIndex) -
              Math.floor(budget / 3),
          ),
        );
  const [manualOffsets, setManualOffsets] = useState<
    Record<PlanView, number | undefined>
  >({ plan: undefined, output: undefined });
  const offset = virtual
    ? Math.min(maxOffset, manualOffsets[selectedView] ?? followedOffset)
    : 0;
  const setOffset = (
    update: (current: number | undefined) => number | undefined,
  ) =>
    setManualOffsets((current) => ({
      ...current,
      [selectedView]: update(current[selectedView]),
    }));

  useTerminalInput((input, key) => {
    if (collapsible && !key.ctrl && !key.meta && input.toLowerCase() === "p") {
      tree.setExpanded(collapsed);
      return;
    }
    if (collapsed) return;
    if (hasOutput && (key.left || key.right)) {
      tree.setView(selectedView === "plan" ? "output" : "plan");
      return;
    }
    if (!virtual) return;
    const page = Math.max(1, Math.floor(lineBudget));
    if (key.up) setOffset((current) => Math.max(0, (current ?? offset) - 1));
    else if (key.down)
      setOffset((current) => Math.min(maxOffset, (current ?? offset) + 1));
    else if (key.pageUp)
      setOffset((current) => Math.max(0, (current ?? offset) - page));
    else if (key.pageDown)
      setOffset((current) => Math.min(maxOffset, (current ?? offset) + page));
    else if (key.home) setOffset(() => 0);
    else if (key.end) setOffset(() => undefined);
  });

  return {
    selectedView,
    hasOutput,
    virtual,
    budget,
    offset,
    hiddenBelow: virtual ? Math.max(0, length - offset - budget) : 0,
    planLines:
      virtual && selectedView === "plan"
        ? expandedLines.slice(offset, offset + budget)
        : undefined,
  };
};
