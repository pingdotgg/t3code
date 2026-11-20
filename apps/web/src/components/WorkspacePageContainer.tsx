import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";

export type WorkspacePageWidth = "readable" | "wide" | "expanded" | "canvas";

const WIDTH_CLASS: Record<WorkspacePageWidth, string> = {
  readable: "max-w-4xl",
  wide: "max-w-5xl",
  expanded: "max-w-6xl",
  // Dashboards and canvases: `wide` until the window passes 100rem, where the route modal
  // starts to grow, then all the width their surface has.
  canvas: "max-w-5xl min-[100rem]:max-w-none",
};

export function WorkspacePageContainer({
  width = "readable",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & { readonly width?: WorkspacePageWidth }) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-6 px-5 pt-6 pb-12 sm:px-6",
        WIDTH_CLASS[width],
        className,
      )}
      {...props}
    />
  );
}
