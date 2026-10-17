import { createElement, useEffect, useState, type ComponentProps, type ComponentType } from "react";
import { preloadSpeculatively } from "../lib/chunkReloadGuard";

export const terminalDrawerSurface: ReturnType<
  typeof loadableComponent<ComponentProps<(typeof import("./ThreadTerminalDrawer"))["default"]>>
> = loadableComponent(() => import("./ThreadTerminalDrawer"));
export const diffPanelSurface: ReturnType<
  typeof loadableComponent<ComponentProps<(typeof import("./DiffPanel"))["default"]>>
> = loadableComponent(() => import("./DiffPanel"));
/** Only renderer assets; opening a PTY remains behind terminal intent. */
export const preloadTerminalDrawer = async (): Promise<void> => {
  await Promise.all([
    terminalDrawerSurface.preload(),
    preloadSpeculatively(() =>
      import("../terminal/ghostty/surface").then(({ preloadTerminalAssets }) =>
        preloadTerminalAssets(),
      ),
    ),
  ]);
};

/** Load on demand without Suspense's minimum fallback reveal delay. */
function loadableComponent<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
) {
  let loaded: ComponentType<Props> | null = null;
  const resolve = () => load().then((module) => (loaded = module.default));

  function Loadable(props: Props) {
    const [result, setResult] = useState<
      { component: ComponentType<Props> } | { error: unknown } | null
    >(() => (loaded === null ? null : { component: loaded }));
    useEffect(() => {
      if (result !== null) return;
      // Real use retries failed speculative imports.
      void resolve().then(
        (component) => setResult({ component }),
        (error: unknown) => setResult({ error }),
      );
    }, [result]);
    if (result !== null && "error" in result) throw result.error;
    return result === null ? null : createElement(result.component, props);
  }

  return { Component: Loadable, preload: () => preloadSpeculatively(resolve) };
}
