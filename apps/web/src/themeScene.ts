import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry, subscribeAtomChanges } from "./rpc/atomRegistry";
import { assetEnvironment } from "./state/assets";
import { themeEnvironmentIdAtom } from "./state/primaryEnvironment";
import { themeServerEnvironmentThemesAtom } from "./state/server";
import { environmentSession } from "./state/session";
import { getCustomThemes } from "./themePalette";

/** Messages a scene page receives on `window`, in viewport pixels. */
const THEME_SCENE_POINTER_MESSAGE = "t3-theme-scene:pointer";
const THEME_SCENE_POINTER_LEAVE_MESSAGE = "t3-theme-scene:pointer-leave";

let appliedThemeId: string | undefined;
let shownKey: string | null = null;
let loading: AbortController | null = null;
let frame: HTMLIFrameElement | null = null;

function show(url: string | null): void {
  frame?.remove();
  frame = null;
  const root = document.documentElement;
  if (url === null) {
    delete root.dataset.themeScene;
    return;
  }
  const next = document.createElement("iframe");
  next.className = "theme-scene";
  // No allow-same-origin: the page cannot reach the app, its storage or its session.
  next.setAttribute("sandbox", "allow-scripts");
  next.setAttribute("aria-hidden", "true");
  next.setAttribute("referrerpolicy", "no-referrer");
  next.tabIndex = -1;
  next.addEventListener("load", () => next.setAttribute("data-loaded", ""), { once: true });
  next.src = url;
  document.body.prepend(next);
  frame = next;
  root.dataset.themeScene = "";
}

async function sceneUrl(
  environmentId: EnvironmentId,
  themeId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const minted = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId,
      input: { resource: { _tag: "environment-theme-scene", themeId } },
    }),
    { label: "theme scene", reportFailure: false, refresh: true, signal },
  );
  const connection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  if (minted._tag !== "Success" || connection._tag === "None") return null;
  return resolveAssetUrl(connection.value.httpBaseUrl, minted.value.relativeUrl);
}

/** Shows the scene published beside `themeId` behind the app, or removes it. */
export function applyThemeScene(themeId: string | undefined): void {
  if (typeof document === "undefined") return;
  appliedThemeId = themeId;
  const environmentId = appAtomRegistry.get(themeEnvironmentIdAtom);
  // A saved theme wins its id over a published one, so the published scene is not its.
  const revision =
    themeId === undefined || getCustomThemes().some((theme) => theme.id === themeId)
      ? undefined
      : appAtomRegistry.get(themeServerEnvironmentThemesAtom)?.find((theme) => theme.id === themeId)
          ?.scene;
  const key =
    environmentId === null || themeId === undefined || revision === undefined
      ? null
      : JSON.stringify([environmentId, themeId, revision]);
  if (key === shownKey) return;
  shownKey = key;
  loading?.abort();
  loading = null;
  show(null);
  if (environmentId === null || themeId === undefined || key === null) return;
  const controller = new AbortController();
  loading = controller;
  sceneUrl(environmentId, themeId, controller.signal).then(
    (url) => {
      if (controller.signal.aborted) return;
      loading = null;
      if (url === null) shownKey = null;
      else show(url);
    },
    () => {
      if (controller.signal.aborted) return;
      loading = null;
      // Lets the next repaint or `online` event try again.
      shownKey = null;
    },
  );
}

/** Forwards the pointer, at most once per frame, so a scene can follow it like a page would. */
function forwardPointer(): () => void {
  let pending: { x: number; y: number } | null = null;
  let scheduled = 0;
  const post = (message: object) => frame?.contentWindow?.postMessage(message, "*");
  const flush = () => {
    scheduled = 0;
    if (pending === null) return;
    post({ type: THEME_SCENE_POINTER_MESSAGE, ...pending });
    pending = null;
  };
  const move = (event: PointerEvent) => {
    if (frame === null) return;
    pending = { x: event.clientX, y: event.clientY };
    if (scheduled === 0) scheduled = requestAnimationFrame(flush);
  };
  const leave = () => post({ type: THEME_SCENE_POINTER_LEAVE_MESSAGE });
  const leaveDocument = (event: PointerEvent) => {
    if (event.relatedTarget === null) leave();
  };
  window.addEventListener("pointermove", move, { passive: true });
  document.addEventListener("pointerout", leaveDocument, { passive: true });
  window.addEventListener("blur", leave);
  return () => {
    cancelAnimationFrame(scheduled);
    window.removeEventListener("pointermove", move);
    document.removeEventListener("pointerout", leaveDocument);
    window.removeEventListener("blur", leave);
  };
}

export function startThemeScene(): () => void {
  const reapply = () => applyThemeScene(appliedThemeId);
  const unsubscribe = subscribeAtomChanges(themeServerEnvironmentThemesAtom, reapply);
  window.addEventListener("online", reapply);
  const stopPointer = forwardPointer();
  return () => {
    unsubscribe();
    window.removeEventListener("online", reapply);
    stopPointer();
    loading?.abort();
    loading = null;
    shownKey = null;
    show(null);
  };
}
