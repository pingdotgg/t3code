export const pluginSdkWebExternalDependencies = [
  "@effect/atom-react",
  "effect",
  "react",
  "react-dom",
] as const;

export function isPluginSdkWebExternal(id: string): boolean {
  return pluginSdkWebExternalDependencies.some((dependency) => {
    return id === dependency || id.startsWith(`${dependency}/`);
  });
}
