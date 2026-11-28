import type { NavigationAction, NavigationState } from "@react-navigation/native";
import { useEffect, useRef, type RefObject } from "react";
import type { SplitHostCommands } from "react-native-screens";
import {
  collapsedSplitTransition,
  type CollapsedSplitColumn,
} from "../../native/workspace-stack-projection";
import { setNativelyPoppingWorkspaceRoute } from "./workspace/workspace-detail-selection";

type Appearance = "willAppear" | "didAppear" | "willDisappear" | "didDisappear";

/** Keeps the column a collapsed split shows in step with the router's active detail. */
export function useCollapsedSplitColumn(input: {
  readonly hostRef: RefObject<SplitHostCommands | null>;
  readonly usesSplitView: boolean;
  readonly compactColumn: CollapsedSplitColumn["visible"];
  readonly primaryKey: string;
  readonly navigation: {
    readonly getState: () => Pick<NavigationState, "key" | "index" | "routes">;
    readonly dispatch: (action: NavigationAction) => void;
  };
}) {
  const { hostRef, usesSplitView, compactColumn } = input;
  const collapsed = useRef(!usesSplitView);
  const column = useRef<CollapsedSplitColumn>({ visible: compactColumn, leaving: null });

  const showCompactColumn = () => {
    if (usesSplitView || column.current.visible === compactColumn) return;
    column.current = { ...column.current, visible: compactColumn };
    hostRef.current?.show(compactColumn);
  };
  // Every commit, not only when compactColumn changes: a thread picked while folded Back reveals
  // the list survives Back's pop, so the router keeps a detail while UIKit shows the list.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the native split host which column to show while collapsed
  useEffect(showCompactColumn);

  return {
    followAppearance: (type: Appearance, key: string) => {
      if (!collapsed.current || usesSplitView) return;
      const transition = collapsedSplitTransition(
        column.current,
        { type, key },
        input.navigation.getState(),
        input.primaryKey,
      );
      column.current = transition.column;
      setNativelyPoppingWorkspaceRoute(transition.column.leaving);
      // A pop re-renders and the effect above follows it; without one, nothing would re-render.
      if (transition.pop) input.navigation.dispatch(transition.pop);
      else showCompactColumn();
    },
    onCollapse: () => {
      collapsed.current = true;
      column.current = { visible: compactColumn, leaving: null };
      setNativelyPoppingWorkspaceRoute(null);
    },
    onExpand: () => {
      collapsed.current = false;
      setNativelyPoppingWorkspaceRoute(null);
    },
  };
}
