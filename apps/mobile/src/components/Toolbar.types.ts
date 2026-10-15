import type { ReactElement, ReactNode } from "react";

/** Navigation toolbars attach to the current screen; floating groups stay in layout. */
export type ToolbarProps =
  | { readonly placement: "left" | "right" | "bottom"; readonly children?: ReactNode }
  | { readonly placement?: undefined; readonly children: ReactElement };
