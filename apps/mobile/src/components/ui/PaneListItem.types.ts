import type { ReactNode } from "react";

export interface PaneListItemProps {
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}
