import {
  AuthPreviewOperateScope,
  type BrowserLinkTarget,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { readEnvironmentScope } from "~/state/session";
import { isPreviewAvailableFor } from "./previewRuntime";
import { isWebUrl } from "./webUrl";

export { isWebUrl };

export interface ResolveLinkTargetInput {
  readonly url: string;
  readonly event: {
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly button?: number | undefined;
  };
  readonly preference: BrowserLinkTarget;
  readonly canOpenInApp: boolean;
  /** The environment's browser reaches the host's loopback whatever it binds, so a plain click goes there. */
  readonly opensInEnvironmentBrowser?: boolean;
}

export function resolveLinkTarget(input: ResolveLinkTargetInput): BrowserLinkTarget {
  if (input.event.metaKey || input.event.ctrlKey || input.event.button === 1) return "system";
  if (!input.canOpenInApp) return "system";
  if (!isWebUrl(input.url)) return "system";
  if (input.opensInEnvironmentBrowser) return "app";
  return input.preference;
}

/** Before hydration, the default "system" would ignore a saved "app" link target. */
export async function resolveBrowserLinkTargetPreference(): Promise<BrowserLinkTarget> {
  await ensureClientSettingsHydrated();
  return getClientSettings().browserLinkTarget;
}

export function canOpenLinksInApp(threadRef: ScopedThreadRef | null | undefined): boolean {
  return (
    threadRef != null &&
    readEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope) &&
    isPreviewAvailableFor(threadRef.environmentId)
  );
}
