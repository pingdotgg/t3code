import type { MenuAction } from "@react-native-menu/menu";
import type { ReactNode } from "react";

/** A menu action whose `leading` view, such as a project favicon, replaces its symbol icon. */
export type AndroidMenuAction = Omit<MenuAction, "subactions"> & {
  readonly leading?: ReactNode;
  readonly subactions?: AndroidMenuAction[];
};

export interface MaterialMenuPopupProps {
  readonly menuWidth: number;
  readonly anchor: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly actions: readonly AndroidMenuAction[];
  readonly title?: string;
  readonly parent: AndroidMenuAction | null;
  readonly onPress: (action: AndroidMenuAction) => void;
  readonly onBack: () => void;
  readonly onClose: () => void;
  /** Keep the editor's window focus and keyboard while showing native menu rows. */
  readonly inline?: boolean;
}

export function MaterialMenuPopup(_props: MaterialMenuPopupProps) {
  return null;
}
