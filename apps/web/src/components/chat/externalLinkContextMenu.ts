import type { ContextMenuItem } from "@t3tools/contracts";

export type ExternalLinkContextMenuAction = "open-in-preview" | "open-external" | "copy-link";

export type ExternalLinkContextMenuFailureOperation =
  | "show-link-context-menu"
  | "open-link-in-preview"
  | "open-link-external"
  | "copy-link";

const FAILURE_OPERATION_BY_ACTION = {
  "open-in-preview": "open-link-in-preview",
  "open-external": "open-link-external",
  "copy-link": "copy-link",
} as const satisfies Record<ExternalLinkContextMenuAction, ExternalLinkContextMenuFailureOperation>;

const EXTERNAL_LINK_CONTEXT_MENU_ITEMS = [
  { id: "open-in-preview", label: "Open in integrated browser" },
  { id: "open-external", label: "Open in system browser" },
  { id: "copy-link", label: "Copy Link" },
] as const satisfies readonly ContextMenuItem<ExternalLinkContextMenuAction>[];

/**
 * The integrated browser is not always there to offer — it needs a thread to open beside and a
 * runtime that can show it — but the other two answers hold wherever a link does. Dropping the
 * whole menu with the one item that cannot be honoured is what left a right-click on a link
 * showing the platform's cut-and-paste menu instead of a way to copy the link.
 */
export function externalLinkContextMenuItems(options: {
  readonly canOpenInPreview: boolean;
}): readonly ContextMenuItem<ExternalLinkContextMenuAction>[] {
  return options.canOpenInPreview
    ? EXTERNAL_LINK_CONTEXT_MENU_ITEMS
    : EXTERNAL_LINK_CONTEXT_MENU_ITEMS.filter((item) => item.id !== "open-in-preview");
}

interface ShowExternalLinkContextMenuOptions {
  readonly href: string;
  readonly position: { readonly x: number; readonly y: number };
  /** Absent means yes, which is what every caller before the browser could be missing meant. */
  readonly canOpenInPreview?: boolean;
  readonly showContextMenu: (
    items: readonly ContextMenuItem<ExternalLinkContextMenuAction>[],
    position: { readonly x: number; readonly y: number },
  ) => Promise<ExternalLinkContextMenuAction | null>;
  readonly openInPreview: (href: string) => Promise<void>;
  readonly openExternal: (href: string) => Promise<void>;
  readonly copyLink: (href: string) => Promise<unknown>;
  readonly reportFailure: (
    operation: ExternalLinkContextMenuFailureOperation,
    cause: unknown,
  ) => void;
}

function resolveExternalWebLink(href: string | null | undefined): URL | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export function resolveExternalWebLinkHref(href: string | null | undefined): string | null {
  return resolveExternalWebLink(href)?.href ?? null;
}

export function resolveExternalWebLinkHost(href: string | undefined): string | null {
  return resolveExternalWebLink(href)?.hostname || null;
}

export async function showExternalLinkContextMenu({
  href,
  position,
  canOpenInPreview = true,
  showContextMenu,
  openInPreview,
  openExternal,
  copyLink,
  reportFailure,
}: ShowExternalLinkContextMenuOptions): Promise<void> {
  let action: ExternalLinkContextMenuAction | null;
  try {
    action = await showContextMenu(externalLinkContextMenuItems({ canOpenInPreview }), position);
  } catch (cause) {
    reportFailure("show-link-context-menu", cause);
    return;
  }

  try {
    if (action === "open-in-preview") {
      await openInPreview(href);
    } else if (action === "open-external") {
      await openExternal(href);
    } else if (action === "copy-link") {
      await copyLink(href);
    }
  } catch (cause) {
    if (action) reportFailure(FAILURE_OPERATION_BY_ACTION[action], cause);
  }
}
