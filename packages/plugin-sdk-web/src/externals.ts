// Modules a plugin web bundle must NOT bundle: the host serves each of these
// as a shared singleton through the runtime import map (see
// `pluginHostImportMap` in @t3tools/shared/pluginHostWeb — keep the two in
// sync; hostSingletons.test.ts guards the pairing). Subpath specifiers in the
// import map (react-dom/client, react/jsx-runtime, ...) are covered by the
// `${dependency}/` prefix rule below.
export const pluginSdkWebExternalDependencies = [
  "@effect/atom-react",
  "@t3tools/contracts",
  "@t3tools/plugin-sdk-web",
  "effect",
  "react",
  "react-dom",
] as const;

export function isPluginSdkWebExternal(id: string): boolean {
  return pluginSdkWebExternalDependencies.some((dependency) => {
    return id === dependency || id.startsWith(`${dependency}/`);
  });
}
