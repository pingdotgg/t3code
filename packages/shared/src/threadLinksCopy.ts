import type { EnvironmentId } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { ThreadLink } from "./threadLinks.ts";

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
