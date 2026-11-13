import type { ReactNode } from "react";
import type { ScrollViewProps } from "react-native";

/** The body of a `sheetRoute({ androidFit: true })` screen: a header over one scrolling form. */
export interface FitSheetProps extends Omit<
  ScrollViewProps,
  "children" | "className" | "nestedScrollEnabled" | "contentInsetAdjustmentBehavior"
> {
  readonly header: ReactNode;
  readonly children: ReactNode;
  /** Submit actions, kept reachable below the form. */
  readonly footer?: ReactNode;
  /** Lifts the sheet above the keyboard, for forms whose inputs sit low. */
  readonly avoidsKeyboard?: boolean;
}

export const fitSheetBottomInset = (bottom: number) => Math.max(bottom, 18) + 18;
