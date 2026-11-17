import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";

import type { RightPanelSurface } from "../rightPanelStore";

/** Tabs show the command; the tooltip retains the complete terminal label. */
export function terminalTabTitle(terminalId: string, label: string | undefined): string {
  const command = label?.split(" · ").at(-1)?.trim();
  return command && label !== getTerminalLabel(terminalId) ? command : "Terminal";
}

/** Active headers and parked tabs name the same resource, without its linked thread. */
export function surfaceTabTitle(
  surface: RightPanelSurface,
  snapshot: PreviewSessionSnapshot | null | undefined,
  terminalLabel?: string,
): string {
  switch (surface.kind) {
    case "diff":
      return "Diff";
    case "files":
      return "Files";
    case "file":
      return surface.relativePath.slice(
        Math.max(surface.relativePath.lastIndexOf("/"), surface.relativePath.lastIndexOf("\\")) + 1,
      );
    case "terminal":
      return terminalTabTitle(surface.activeTerminalId, terminalLabel);
    case "pull-request":
      return `#${surface.number}`;
    case "pull-requests":
      return "Pull requests";
    case "device":
      return surface.title ?? surface.target?.name ?? "Device";
    case "side-chat":
      return "Side chat";
    case "preview": {
      const navigation = snapshot?.navStatus;
      if (navigation && navigation._tag !== "Idle" && navigation.title.trim()) {
        return navigation.title;
      }
      const url =
        navigation && navigation._tag !== "Idle"
          ? navigation.url
          : surface.resourceId
            ? surface.url
            : undefined;
      if (!url) return "Browser";
      try {
        return new URL(url).host || "Browser";
      } catch {
        return "Browser";
      }
    }
  }
}
