import type { ContextMenuItem } from "@t3tools/contracts";
import {
  type SourceControlDefinition,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
} from "@t3tools/client-runtime/source-control-clients";

import { msg } from "gt-react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { m, type MessageResolver } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";

import { toastManager } from "../ui/toast";

export type PullRequestLinkContextMenuAction = "copy-link" | "open-external";

export const openOnHostLabel = (
  host: SourceControlDefinition,
  resolve: MessageResolver = m,
): string =>
  host === UNKNOWN_SOURCE_CONTROL_CLIENT
    ? resolve(msg("Open on host"))
    : resolve(msg("Open on {host}", { host: host.label }));

function pullRequestLinkContextMenuItems(
  openLabel: string,
): readonly ContextMenuItem<PullRequestLinkContextMenuAction>[] {
  return [
    { id: "copy-link", label: m(msg("Copy link")), icon: "copy" },
    { id: "open-external", label: openLabel },
  ];
}

export async function showPullRequestLinkContextMenu({
  url,
  openLabel,
  position,
}: {
  readonly url: string;
  readonly openLabel: string;
  readonly position: { readonly x: number; readonly y: number };
}): Promise<void> {
  const api = readLocalApi();
  if (!api) return;
  let action: PullRequestLinkContextMenuAction | null = null;
  try {
    action = await api.contextMenu.show(pullRequestLinkContextMenuItems(openLabel), position);
  } catch {
    return;
  }
  try {
    if (action === "copy-link")
      await writeTextToClipboard(url, {
        target: "link",
        unavailableMessage: msg("Clipboard API is unavailable while copying link."),
        failureMessage: msg("Failed to copy link to the clipboard."),
      });
    else if (action === "open-external") await api.shell.openExternal(url);
  } catch {
    toastManager.add({
      type: "error",
      title:
        action === "copy-link"
          ? m(msg("Could not copy the link"))
          : m(msg("Could not open the link")),
    });
  }
}
