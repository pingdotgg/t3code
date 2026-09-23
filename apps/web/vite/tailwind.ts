import tailwindcss from "@tailwindcss/vite";

/** Adapts Tailwind's dev hooks to Vite's experimental bundled mode. */
export function tailwindPlugins(bundledDev: boolean) {
  const plugins = tailwindcss();
  if (bundledDev) {
    for (const plugin of plugins) {
      // This hook expects Vite ModuleNodes and a server, which Rolldown does
      // not supply. Bundled dev tracks Tailwind's addWatchFile dependencies
      // and rebuilds CSS when those files change without this hook.
      delete plugin.hotUpdate;
    }
  }
  return plugins;
}
