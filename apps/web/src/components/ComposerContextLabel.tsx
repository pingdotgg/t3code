import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "./chat/threadDetailsPanelStyles";

export function ComposerContextLabel({
  children,
  displayMode = "toolbar",
  compact = "hide",
}: {
  children: ReactNode;
  displayMode?: "toolbar" | "panel";
  /** "truncate" keeps a short label until the row compacts its branch too. */
  compact?: "hide" | "truncate";
}) {
  const compactable = compact === "hide";
  return (
    <span
      data-composer-label={compact}
      className={cn(
        "min-w-0",
        displayMode === "panel"
          ? "flex-1 overflow-x-clip overflow-y-visible text-left"
          : compactable
            ? "max-w-[240px] transition-[margin-inline-start] duration-180 ease-drawer group-data-[compact]/composer-context:-ms-1.5 group-data-[compact]/composer-context:max-w-0 motion-reduce:transition-none"
            : "max-w-[240px] group-data-[compact=branch]/composer-context:max-w-24",
      )}
    >
      <span
        data-composer-label-motion
        className={cn(
          "block w-full min-w-0 truncate",
          THREAD_DETAILS_PANEL_LABEL_CLASS,
          displayMode === "toolbar" &&
            compactable &&
            "max-w-[240px] transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none",
        )}
      >
        {children}
      </span>
    </span>
  );
}
