import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import {
  formatThreadLink,
  replaceThreadLinks,
  threadLinkCandidates,
  threadLinkHref,
  type ThreadLink,
} from "./threadLinks.ts";

/** @public */
export function unknownThreadLinkLabel(
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
  resolve: MFunctionType = mFallback,
): string {
  return link.environmentId === null || link.environmentId === messageEnvironmentId
    ? resolve(msg("Thread no longer available"))
    : resolve(msg("Thread on another machine"));
}

/**
 * Writes each link with its thread's current title, a hosted link as a v2 link. A v2 link `title`
 * cannot resolve keeps its written label or a neutral one and goes to `onUnresolved`. An unresolved
 * v1 link becomes plain text, except a labeled one, which may open elsewhere.
 */
export function relabelThreadLinks(
  markdown: string,
  messageEnvironmentId: EnvironmentId,
  title: (ref: ScopedThreadRef) => string | undefined,
  resolve: MFunctionType = mFallback,
  onUnresolved?: (href: string) => void,
): string {
  return replaceThreadLinks(markdown, (written, label) => {
    for (const ref of threadLinkCandidates(written, messageEnvironmentId)) {
      const current = title(ref);
      if (current === undefined) continue;
      return formatThreadLink(
        { environmentId: written.environmentId, threadId: ref.threadId },
        current.trim() || label || ref.threadId,
      );
    }
    if (label !== undefined && written.environmentId === null) return undefined;
    const unresolvedLabel =
      label?.trim() || unknownThreadLinkLabel(written, messageEnvironmentId, resolve);
    if (written.environmentId === null) return unresolvedLabel;
    onUnresolved?.(threadLinkHref(written));
    return formatThreadLink(written, unresolvedLabel);
  });
}
