import type { MobileThemeId } from "../../lib/mobileTheme";
import type { ShowcaseScene } from "./nativeShowcaseScene";

export type ShowcaseRenderSignal = Readonly<{
  scene: ShowcaseScene;
  themeId: MobileThemeId;
}>;

const listeners = new Set<() => void>();
let renderSignal: ShowcaseRenderSignal | null = null;

export function getShowcaseRenderSignal(): ShowcaseRenderSignal | null {
  return renderSignal;
}

export function subscribeToShowcaseRenderSignal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportShowcaseSceneRendered(signal: ShowcaseRenderSignal): void {
  renderSignal = signal;
  for (const listener of listeners) listener();
}

export function clearShowcaseRenderSignal(): void {
  if (renderSignal === null) return;
  renderSignal = null;
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
