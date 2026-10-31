import type { AnimatedLegendListSharedValues } from "@legendapp/list/reanimated";
import type { ReactNode } from "react";

import { SegmentedControl } from "../../components/ui/SegmentedControl";

export type PullRequestSection = "overview" | "guide" | "activity";

export interface PullRequestTabControlProps {
  readonly options: readonly { readonly value: PullRequestSection; readonly label: string }[];
  readonly selected: PullRequestSection;
  readonly onSelect: (section: PullRequestSection) => void;
  /** Top inset the lists scroll under. */
  readonly barInsetTop: number;
  /** Top padding of each list's content container. */
  readonly listPaddingTop: number;
}

export interface PullRequestTabControl {
  readonly listSharedValues: (
    section: PullRequestSection,
  ) => AnimatedLegendListSharedValues | undefined;
  /** Reports the y of the list header view that holds `header`. */
  readonly onHeaderLayout: (y: number) => void;
  /** Goes in each list header. */
  readonly header: ReactNode;
  /** Goes above the lists. */
  readonly overlay: ReactNode;
}

// oxlint-disable-next-line t3code/no-hookless-use-function -- Non-iOS stub of a hook; the .ios.tsx file calls hooks.
export function usePullRequestTabControl(props: PullRequestTabControlProps): PullRequestTabControl {
  return {
    listSharedValues: () => undefined,
    onHeaderLayout: () => {},
    header: (
      <SegmentedControl
        options={props.options}
        selected={props.selected}
        onSelect={props.onSelect}
        role="tab"
        size="compact"
      />
    ),
    overlay: null,
  };
}
