import type { MenuAction } from "@react-native-menu/menu";
import type { ReactNode } from "react";

export interface MenuPopupProps {
  readonly menuWidth: number;
  readonly anchor: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly actions: readonly MenuAction[];
  readonly title?: string;
  readonly parent: MenuAction | null;
  readonly onPress: (action: MenuAction) => void;
  readonly onBack: () => void;
  readonly onClose: () => void;
  readonly inline?: boolean;
  readonly renderLeadingIcon?: (action: MenuAction) => ReactNode;
}

export function MenuPopup(_props: MenuPopupProps) {
  return null;
}
