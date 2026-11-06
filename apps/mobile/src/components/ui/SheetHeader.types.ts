import type { ReactNode } from "react";

import type { AppBarAction, AppBarMenu } from "./AppBar.types";

type SheetDismissAction =
  | { readonly onCancel: () => void; readonly onClose?: never }
  | { readonly onClose: () => void; readonly onCancel?: never };

type SheetConfirmation = {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
};

export type SheetHeaderProps = SheetDismissAction & {
  readonly title: string;
  readonly subtitle?: string;
  readonly accessibilityLabel?: string;
  readonly dismissDisabled?: boolean;
  readonly confirm?: SheetConfirmation;
  readonly presentation?: "native" | "inline";
  readonly actions?: ReadonlyArray<AppBarAction>;
  readonly menus?: ReadonlyArray<AppBarMenu>;
  readonly trailing?: ReactNode;
};

export type SheetCloseButtonProps = SheetDismissAction & {
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
};
