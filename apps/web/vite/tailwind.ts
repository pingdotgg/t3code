import tailwindcss from "@tailwindcss/vite";

export function tailwindPlugins(bundledDev: boolean) {
  const plugins = tailwindcss();
  if (bundledDev) {
    for (const plugin of plugins) {
      // Rolldown lacks Vite ModuleNodes/server; bundled dev rebuilds from addWatchFile dependencies instead.
      delete plugin.hotUpdate;
    }
  }
  return plugins;
}
