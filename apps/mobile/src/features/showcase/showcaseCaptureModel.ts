import type { MobileThemeId, MobileThemeIds } from "../../lib/mobileTheme";
import type { ShowcaseScene } from "./nativeShowcaseScene";
import { isShowcaseNativeContentReady, type ShowcaseRenderSignal } from "./showcaseRenderSignal";

export const SHOWCASE_THREAD_ID = "remote-command-center";

function sceneFromPathname(pathname: string): ShowcaseScene | null {
  const routePath = pathname.split(/[?#]/u, 1)[0] ?? pathname;
  if (routePath === "/settings" || routePath.endsWith("/settings/environments")) {
    return "environments";
  }
  if (routePath.endsWith("/terminal")) return "terminal";
  if (routePath.endsWith("/review")) return "review";
  if (routePath.startsWith("/threads/")) return "thread";
  if (routePath === "/") return "threads";
  return null;
}

/** Agent activity is staged on the threads list, so that route counts as the scene. */
export function showcaseSceneOnScreen(
  requestedScene: ShowcaseScene | null,
  pathname: string,
): ShowcaseScene | null {
  const routeScene = sceneFromPathname(pathname);
  return requestedScene === "agent-activity" && routeScene === "threads"
    ? "agent-activity"
    : routeScene;
}

export function isShowcaseThemeApplied(input: {
  readonly launchRequestRead: boolean;
  readonly requestedTheme: MobileThemeId | null;
  readonly themeIds: MobileThemeIds;
}): boolean {
  if (input.requestedTheme === null) return input.launchRequestRead;
  return (
    input.themeIds.light === input.requestedTheme && input.themeIds.dark === input.requestedTheme
  );
}

export interface ShowcaseReadinessInput {
  readonly scene: ShowcaseScene | null;
  readonly requestedScene: ShowcaseScene | null;
  readonly hasFixture: boolean;
  readonly orientationSettled: boolean;
  readonly themeApplied: boolean;
  readonly agentActivityStaged: boolean;
  readonly themeId: MobileThemeId;
  readonly renderSignal: ShowcaseRenderSignal | null;
  /** Counts render-signal changes; a redraw report restarts the settle delay. */
  readonly renderReports: number;
}

/**
 * The capture key for a scene that is ready to be marked, or null while any
 * precondition is missing. A changed key restarts the settle delay.
 */
export function showcaseReadinessKey(input: ShowcaseReadinessInput): string | null {
  const { scene } = input;
  if (
    scene === null ||
    scene !== input.requestedScene ||
    !input.hasFixture ||
    !input.orientationSettled ||
    !input.themeApplied ||
    (scene === "agent-activity" && !input.agentActivityStaged) ||
    !isShowcaseNativeContentReady({
      scene,
      themeId: input.themeId,
      renderSignal: input.renderSignal,
    })
  ) {
    return null;
  }
  return [scene, input.themeId, input.renderReports].join("|");
}
