import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry, subscribeAtomChanges } from "./rpc/atomRegistry";
import { assetEnvironment } from "./state/assets";
import { themeEnvironmentIdAtom } from "./state/primaryEnvironment";
import { themeServerEnvironmentThemesAtom } from "./state/server";
import { environmentSession } from "./state/session";

const THEME_BACKGROUND_VARIABLE = "--theme-background-image";

let shownKey: string | null = null;
let loading: AbortController | null = null;
let objectUrl: string | null = null;

function show(nextUrl: string | null): void {
  const root = document.documentElement;
  if (nextUrl === null) root.style.removeProperty(THEME_BACKGROUND_VARIABLE);
  else root.style.setProperty(THEME_BACKGROUND_VARIABLE, `url("${nextUrl}")`);
  if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
  objectUrl = nextUrl;
}

async function loadBackground(
  environmentId: EnvironmentId,
  themeId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const minted = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId,
      input: { resource: { _tag: "environment-theme-background", themeId } },
    }),
    { label: "theme background", reportFailure: false, refresh: true, signal },
  );
  const connection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  if (minted._tag !== "Success" || connection._tag === "None") return null;
  const url = resolveAssetUrl(connection.value.httpBaseUrl, minted.value.relativeUrl);
  if (url === null) return null;
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  const image = await response.blob();
  return image.type.startsWith("image/") ? URL.createObjectURL(image) : null;
}

/**
 * Sets `--theme-background-image` to the image published beside `themeId`, or clears it.
 * The image is copied into a blob URL once per revision, so the signed URL may expire.
 */
export function applyThemeBackground(themeId: string | undefined): void {
  if (typeof document === "undefined") return;
  const environmentId = appAtomRegistry.get(themeEnvironmentIdAtom);
  const revision =
    themeId === undefined
      ? undefined
      : appAtomRegistry.get(themeServerEnvironmentThemesAtom)?.find((theme) => theme.id === themeId)
          ?.background;
  const key =
    environmentId === null || themeId === undefined || revision === undefined
      ? null
      : JSON.stringify([environmentId, themeId, revision]);
  if (key === shownKey) return;
  shownKey = key;
  loading?.abort();
  loading = null;
  // The previous image must not show under the next theme while it loads.
  show(null);
  if (environmentId === null || themeId === undefined || key === null) return;
  const controller = new AbortController();
  loading = controller;
  const failed = () => {
    if (controller.signal.aborted) return;
    // Lets the next repaint try again.
    shownKey = null;
  };
  loadBackground(environmentId, themeId, controller.signal).then((url) => {
    if (controller.signal.aborted) {
      if (url !== null) URL.revokeObjectURL(url);
      return;
    }
    loading = null;
    if (url === null) failed();
    else show(url);
  }, failed);
}

/** A new image revision does not change the palette, so it does not repaint the theme. */
export function startThemeBackground(): () => void {
  return subscribeAtomChanges(themeServerEnvironmentThemesAtom, () =>
    applyThemeBackground(document.documentElement.dataset.themeId),
  );
}
