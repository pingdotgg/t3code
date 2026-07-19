import type { ContextMenuItem } from "@t3tools/contracts";

export type ExternalLinkContextMenuAction = "open-in-browser" | "open-external" | "copy-link";

export type ExternalLinkContextMenuFailureOperation =
  | "show-link-context-menu"
  | "open-link-in-preview"
  | "open-link-external"
  | "copy-link";

const FAILURE_OPERATION_BY_ACTION = {
  "open-in-browser": "open-link-in-preview",
  "open-external": "open-link-external",
  "copy-link": "copy-link",
} as const satisfies Record<ExternalLinkContextMenuAction, ExternalLinkContextMenuFailureOperation>;

const EXTERNAL_LINK_CONTEXT_MENU_ITEMS = [
  { id: "open-in-browser", label: "Open in integrated browser" },
  { id: "open-external", label: "Open in system browser" },
  { id: "copy-link", label: "Copy Link" },
] as const satisfies readonly ContextMenuItem<ExternalLinkContextMenuAction>[];

interface ShowExternalLinkContextMenuOptions {
  readonly href: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly showContextMenu: (
    items: readonly ContextMenuItem<ExternalLinkContextMenuAction>[],
    position: { readonly x: number; readonly y: number },
  ) => Promise<ExternalLinkContextMenuAction | null>;
  readonly openInBrowser: (href: string) => Promise<void>;
  readonly openExternal: (href: string) => Promise<void>;
  readonly copyLink: (href: string) => Promise<unknown>;
  readonly reportFailure: (
    operation: ExternalLinkContextMenuFailureOperation,
    cause: unknown,
  ) => void;
}

export function isExternalWebLink(href: string): boolean {
  try {
    const url = new URL(href);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export async function showExternalLinkContextMenu({
  href,
  position,
  showContextMenu,
  openInBrowser,
  openExternal,
  copyLink,
  reportFailure,
}: ShowExternalLinkContextMenuOptions): Promise<void> {
  let action: ExternalLinkContextMenuAction | null;
  try {
    action = await showContextMenu(EXTERNAL_LINK_CONTEXT_MENU_ITEMS, position);
  } catch (cause) {
    reportFailure("show-link-context-menu", cause);
    return;
  }

  try {
    if (action === "open-in-browser") {
      await openInBrowser(href);
    } else if (action === "open-external") {
      await openExternal(href);
    } else if (action === "copy-link") {
      await copyLink(href);
    }
  } catch (cause) {
    if (action) reportFailure(FAILURE_OPERATION_BY_ACTION[action], cause);
  }
}
