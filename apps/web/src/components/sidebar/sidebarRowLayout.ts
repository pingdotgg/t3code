import { createContext, type ReactNode } from "react";

import type { SidebarRowLine, SidebarRowToken } from "@t3tools/client-runtime/thread-row-layout";

export * from "@t3tools/client-runtime/thread-row-layout";

const SHARED_TEXT_CLASS_NAME = "min-w-0 max-w-max basis-0 grow-[100]";

/**
 * Text items split a crowded line evenly and give back what they don't need, so a short branch
 * keeps its full width beside a long project name. Spacers get only what the text leaves over.
 */
export function sidebarRowItemFlexClassName(token: SidebarRowToken, titleStretches: boolean) {
  switch (token.id) {
    case "spacer":
      return "min-w-0 flex-1";
    case "title":
      return titleStretches ? "min-w-0 basis-0 grow-[100]" : SHARED_TEXT_CLASS_NAME;
    case "projectName":
    case "branch":
      return SHARED_TEXT_CLASS_NAME;
    case "environment":
      return token.form === "wide" ? SHARED_TEXT_CLASS_NAME : "shrink-0";
    default:
      return "shrink-0";
  }
}

export interface SidebarRowLayoutItem {
  readonly token: SidebarRowToken;
  /** Null when this thread has nothing to show for the item, such as no pull request. */
  readonly node: ReactNode;
}

/** Set only by the layout editor, which wraps each line of the real row in drag targets. */
export const SidebarRowLayoutEditingContext = createContext<{
  renderLine: (
    line: Exclude<SidebarRowLine, "hidden">,
    items: ReadonlyArray<SidebarRowLayoutItem>,
  ) => ReactNode;
} | null>(null);
