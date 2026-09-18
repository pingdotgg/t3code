import type { ReactNode } from "react";

import { cn } from "../lib/utils";

/** Keeps text measurable while the composer's outer label box collapses. */
export function ComposerContextLabel({
  children,
  displayMode = "toolbar",
}: {
  children: ReactNode;
  displayMode?: "toolbar" | "panel";
}) {
  return (
    <span
      data-composer-label
      className={cn(
        "min-w-0",
        displayMode === "panel"
          ? "flex-1 truncate text-left"
          : "max-w-[240px] group-data-[compact]/composer-context:max-w-0",
      )}
    >
      <span
        data-composer-label-motion
        className={cn(
          "block w-full min-w-0 truncate",
          displayMode === "toolbar" &&
            "max-w-[240px] transition-opacity duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none",
        )}
      >
        {children}
      </span>
    </span>
  );
}
