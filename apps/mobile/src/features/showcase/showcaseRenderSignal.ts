import type { MobileThemeId } from "../../lib/mobileTheme";
import type { ShowcaseScene } from "./nativeShowcaseScene";

export type ShowcaseRenderSignal = Readonly<{
  scene: ShowcaseScene;
  themeId: MobileThemeId;
}>;

const listeners = new Set<() => void>();
export type ShowcaseRenderSnapshot = Readonly<{
  signal: ShowcaseRenderSignal | null;
  // A redraw can repeat the same scene and theme; counting reports lets it restart the settle delay.
  reports: number;
}>;

let snapshot: ShowcaseRenderSnapshot = { signal: null, reports: 0 };

export function getShowcaseRenderSnapshot(): ShowcaseRenderSnapshot {
  return snapshot;
}

export function subscribeToShowcaseRenderSignal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportShowcaseSceneRendered(signal: ShowcaseRenderSignal): void {
  snapshot = { signal, reports: snapshot.reports + 1 };
  for (const listener of listeners) listener();
}

export function clearShowcaseRenderSignal(): void {
  if (snapshot.signal === null) return;
  snapshot = { signal: null, reports: snapshot.reports + 1 };
  for (const listener of listeners) listener();
}

export function isShowcaseNativeContentReady(input: {
  readonly scene: ShowcaseScene;
  readonly themeId: MobileThemeId;
  readonly renderSignal: ShowcaseRenderSignal | null;
}): boolean {
  if (input.scene !== "review") return true;
  return input.renderSignal?.scene === "review" && input.renderSignal.themeId === input.themeId;
}
