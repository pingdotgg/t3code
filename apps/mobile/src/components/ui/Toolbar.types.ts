import type { ReactElement, ReactNode } from "react";

export type ToolbarProps =
  | { readonly placement: "left" | "right" | "bottom"; readonly children?: ReactNode }
  | { readonly placement?: undefined; readonly children: ReactElement };
