// The bundler's entry hash covers the hashed names it imports, so any changed chunk renames the entry.
export function chunkReloadBuild(): string {
  if (typeof document === "undefined") return import.meta.env.APP_VERSION;
  const buildAssetPrefix = `${import.meta.env.BASE_URL}assets/`;
  const entryPath = Array.from(
    document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'),
    (script) => script.getAttribute("src")?.split(/[?#]/, 1)[0],
  ).find((path) => path?.startsWith(buildAssetPrefix));
  return entryPath ?? import.meta.env.APP_VERSION;
}
