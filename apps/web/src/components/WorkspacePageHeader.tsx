import type { ComponentPropsWithoutRef, CSSProperties } from "react";

import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

export function WorkspacePageHeader({
  electron = false,
  reserveNativeControls = electron,
  className,
  style,
  ...props
}: ComponentPropsWithoutRef<"header"> & {
  readonly electron?: boolean;
  readonly reserveNativeControls?: boolean;
}) {
  return (
    <header
      className={cn(
        "flex h-[var(--workspace-topbar-height)]! min-h-[var(--workspace-topbar-height)]! max-h-[var(--workspace-topbar-height)]! shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left,padding-right] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
        electron && "drag-region",
        reserveNativeControls &&
          "ltr:wco:pr-(--workspace-native-controls-inset) rtl:pl-(--workspace-page-header-end)",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        className,
      )}
      style={
        reserveNativeControls
          ? ({
              "--workspace-page-header-end":
                "max(var(--workspace-gutter-start), var(--workspace-controls-left))",
              ...style,
            } as CSSProperties)
          : style
      }
      {...props}
    />
  );
}
