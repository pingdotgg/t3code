import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabelsCopy";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

import type { RightPanelSurface } from "../rightPanelStore";

/** Tabs show the command; the tooltip retains the complete terminal label. */
export function terminalTabTitle(
  terminalId: string,
  label: string | undefined,
  resolve: MessageResolver = m,
): string {
  const command = label?.split(" · ").at(-1)?.trim();
  return command && label !== getTerminalLabel(terminalId, resolve)
    ? command
    : resolve(msg("Terminal"));
}

/** Active headers and parked tabs name the same resource, without its linked thread. */
export function surfaceTabTitle(
  surface: RightPanelSurface,
  snapshot: PreviewSessionSnapshot | null | undefined,
  terminalLabel?: string,
  resolve: MessageResolver = m,
): string {
  switch (surface.kind) {
    case "diff":
      return resolve(msg("Diff"));
    case "files":
      return resolve(msg("Files"));
    case "file":
      return surface.relativePath.slice(
        Math.max(surface.relativePath.lastIndexOf("/"), surface.relativePath.lastIndexOf("\\")) + 1,
      );
    case "terminal":
      return terminalTabTitle(surface.activeTerminalId, terminalLabel, resolve);
    case "pull-request":
      return `#${surface.number}`;
    case "pull-requests":
      return resolve(msg("Pull requests"));
    case "issue":
      // A git host numbers its issues; a tracker with keys of its own, such as Linear, names them.
      return /^\d+$/.test(surface.key) ? `#${surface.key}` : surface.key;
    case "device":
      return surface.title ?? surface.target?.name ?? resolve(msg("Device"));
    case "side-chat":
      return resolve(msg("Side chat"));
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
      if (!url) return resolve(msg("Browser"));
      try {
        return new URL(url).host || resolve(msg("Browser"));
      } catch {
        return resolve(msg("Browser"));
      }
    }
  }
}
