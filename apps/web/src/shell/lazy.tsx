import { type ComponentType, createElement, lazy, Suspense } from "react";

type Bridges = typeof import("./bridges");

/**
 * Wraps a bridge component so its module (and the shell contracts) loads only
 * when it is first mounted, which only happens under a native shell. The
 * bridges render nothing, so the empty Suspense fallback changes no layout.
 */
function lazyBridge<P extends object>(pick: (bridges: Bridges) => ComponentType<P>) {
  const Bridge = lazy(() => import("./bridges").then((bridges) => ({ default: pick(bridges) })));
  return function LazyShellBridge(props: P) {
    return createElement(Suspense, { fallback: null }, createElement(Bridge, props));
  };
}

export const ShellComposerBridge = lazyBridge((b) => b.ShellComposerBridge);
export const ShellEmbedRouteBridge = lazyBridge((b) => b.ShellEmbedRouteBridge);
export const ShellGitBridge = lazyBridge((b) => b.ShellGitBridge);
export const ShellLayoutBridge = lazyBridge((b) => b.ShellLayoutBridge);
export const ShellRightPanelBridge = lazyBridge((b) => b.ShellRightPanelBridge);
export const ShellSettingsBridge = lazyBridge((b) => b.ShellSettingsBridge);
export const ShellThemeBridge = lazyBridge((b) => b.ShellThemeBridge);
export const ShellToastBridge = lazyBridge((b) => b.ShellToastBridge);
export const ShellWorkspaceBridge = lazyBridge((b) => b.ShellWorkspaceBridge);
export const T3ShellBridge = lazyBridge((b) => b.T3ShellBridge);
