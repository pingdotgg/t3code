import { useAtomValue } from "@effect/atom-react";
import { connectionRoutes, routeHttpBaseUrl } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { hostFileUrlPath } from "@t3tools/shared/hostFileLinks";
import {
  safeDecodeURIComponent,
  splitMarkdownLinkSearchAndHash,
} from "@t3tools/shared/markdownLinks";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { isWebUrl } from "../browser/webUrl";
import { reportMarkdownActionFailure } from "../components/chat/markdownActionFailure";
import { environmentCatalog } from "../connection/catalog";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { readLocalApi } from "../localApi";

function originOf(httpBaseUrl: string): string | null {
  try {
    return new URL(httpBaseUrl).origin;
  } catch {
    return null;
  }
}

const NO_ORIGINS: readonly string[] = [];

// The saved routes, not the live connection: a reconnect or a route switch must not turn these
// links back into web links or re-render every message.
const hostFileOriginsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const entry = get(environmentCatalog.catalogValueAtom).entries.get(environmentId);
    const next = [
      ...new Set(
        (entry === undefined ? [] : connectionRoutes(entry)).flatMap((route) => {
          const httpBaseUrl = routeHttpBaseUrl(route);
          const origin = httpBaseUrl === null ? null : originOf(httpBaseUrl);
          return origin === null ? [] : [origin];
        }),
      ),
    ];
    const previous = Option.getOrNull(get.self<readonly string[]>()) ?? NO_ORIGINS;
    return next.length === previous.length && next.every((origin, i) => origin === previous[i])
      ? previous
      : next;
  }).pipe(Atom.withLabel(`host-file-origins:${environmentId}`)),
);

const NO_ORIGINS_ATOM = Atom.make(NO_ORIGINS);

/** The HTTP origins an environment is reached at, where its files may be linked. */
export function useHostFileOrigins(environmentId: EnvironmentId | null): readonly string[] {
  return useAtomValue(
    environmentId === null ? NO_ORIGINS_ATOM : hostFileOriginsAtom(environmentId),
  );
}

/** The file path a link names through one of the environment's addresses, or the href unchanged. */
export function hostFileLinkHref(href: string, environmentOrigins: readonly string[]): string {
  return hostFileUrlPath(href, environmentOrigins) ?? href;
}

function hastHasImage(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if ("tagName" in node && node.tagName === "img") return true;
  return "children" in node && Array.isArray(node.children) && node.children.some(hastHasImage);
}

/** `hostFileLinkHref` for a rendered link; a linked image keeps its URL, so the image stays. */
export function hostFileAnchorHref(
  href: string,
  node: unknown,
  environmentOrigins: readonly string[],
): string {
  return hastHasImage(node) ? href : hostFileLinkHref(href, environmentOrigins);
}

/** An autolink's label is its URL; compare the decoded file path instead. */
export function hostFileLinkLabel(label: string, environmentOrigins: readonly string[]): string {
  const path = hostFileUrlPath(label.trim(), environmentOrigins);
  return path === null ? label : safeDecodeURIComponent(splitMarkdownLinkSearchAndHash(path).path);
}

/** A Ctrl/Cmd- or Shift-click on a file chip that keeps a web URL opens that URL natively. */
export function leavesFileChipClickToBrowser(
  href: string,
  event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey">,
): boolean {
  return isWebUrl(href) && (event.metaKey || event.ctrlKey || event.shiftKey);
}

/** Link items for a file chip that keeps a web URL, since touch has no other way to open it. */
export function hostFileLinkMenuItems(href: string) {
  return isWebUrl(href)
    ? ([
        { id: "open-external", label: "Open in system browser" },
        { id: "copy-link", label: "Copy Link" },
      ] as const)
    : [];
}

/** Runs a link item from `hostFileLinkMenuItems`; false when `clicked` is not one. */
export function runHostFileLinkMenuItem(clicked: string | null, href: string): boolean {
  if (clicked !== "open-external" && clicked !== "copy-link") return false;
  const done =
    clicked === "open-external"
      ? readLocalApi()?.shell.openExternal(href)
      : writeTextToClipboard(href, "link");
  void Promise.resolve(done).catch((cause) =>
    reportMarkdownActionFailure({ operation: clicked, target: href }, cause),
  );
  return true;
}
