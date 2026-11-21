import type { MenuItemAction } from "./Menu.types";

export interface MenuPopupProps {
  readonly menuWidth: number;
  readonly anchor: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly actions: readonly MenuItemAction[];
  readonly title?: string;
  readonly parent: MenuItemAction | null;
  readonly onPress: (action: MenuItemAction) => void;
  readonly onBack: () => void;
  readonly onClose: () => void;
  readonly inline?: boolean;
}

export function MenuPopup(_props: MenuPopupProps) {
  return null;
}
