import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PreviewRuntime, PreviewSessionSnapshot } from "@t3tools/contracts";

import {
  isEnvironmentHostLoopbackUrl,
  resolveClientBrowserUrl,
} from "~/browser/browserTargetResolver";
import { isElectron } from "~/env";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
} from "~/state/entities";

export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  if (!readEnvironmentSupportsServerBrowser(environmentId)) return undefined;
  if (
    isPreviewSupportedInRuntime() &&
    environmentId !== appAtomRegistry.get(primaryEnvironmentIdAtom)
  ) {
    return undefined;
  }
  return "server";
}

/** The host's own browser is the only one sure to reach the host's loopback, whatever it binds. */
export function opensInEnvironmentBrowser(environmentId: EnvironmentId, url: string): boolean {
  return (
    readEnvironmentSupportsServerBrowser(environmentId) &&
    isEnvironmentHostLoopbackUrl(environmentId, url)
  );
}

/** Where an in-app tab for a link runs, and the address it loads there. */
export function previewTargetForLink(
  environmentId: EnvironmentId,
  url: string,
): { readonly url: string; readonly runtime: PreviewRuntime | undefined } {
  if (opensInEnvironmentBrowser(environmentId, url)) return { url, runtime: "server" };
  const runtime = previewRuntimeFor(environmentId);
  return {
    url: runtime === "server" ? url : resolveClientBrowserUrl(environmentId, url),
    runtime,
  };
}

export function alternatePreviewRuntime(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  serverBrowser: boolean,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): PreviewRuntime | null {
  if (!snapshot || !serverBrowser || !isPreviewSupportedInRuntime()) return null;
  if (environmentId === primaryEnvironmentId) return null;
  return snapshot.runtime === "server" ? "desktop" : "server";
}

export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(environmentId);
}

export function usePreviewAvailable(environmentId: EnvironmentId | null): boolean {
  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  return isPreviewSupportedInRuntime() || serverBrowser;
}

export function rendersServerTabNatively(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
): boolean {
  return (
    isElectron &&
    snapshot?.runtime === "server" &&
    !snapshot.headless &&
    primaryEnvironmentId !== null &&
    environmentId === primaryEnvironmentId
  );
}

export function useRendersServerTabNatively(
  environmentId: EnvironmentId,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
): boolean {
  return rendersServerTabNatively(environmentId, useAtomValue(primaryEnvironmentIdAtom), snapshot);
}
