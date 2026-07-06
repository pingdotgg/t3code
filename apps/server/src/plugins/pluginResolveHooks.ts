let pluginsRootUrl = "";

export function initialize(data: unknown) {
  if (data && typeof data === "object" && "pluginsRootUrl" in data) {
    const value = (data as { readonly pluginsRootUrl?: unknown }).pluginsRootUrl;
    if (typeof value === "string") {
      pluginsRootUrl = value.endsWith("/") ? value : `${value}/`;
    }
  }
}

function shouldResolveFromHost(specifier: string, parentURL: string | undefined): boolean {
  if (!parentURL || !pluginsRootUrl || !parentURL.startsWith(pluginsRootUrl)) return false;
  return (
    specifier === "effect" || specifier.startsWith("effect/") || specifier === "@t3tools/plugin-sdk"
  );
}

export async function resolve(
  specifier: string,
  context: { readonly parentURL?: string | undefined },
  nextResolve: (
    specifier: string,
    context: { readonly parentURL?: string | undefined },
  ) => Promise<unknown>,
) {
  if (shouldResolveFromHost(specifier, context.parentURL)) {
    return {
      shortCircuit: true,
      url: import.meta.resolve(specifier),
    };
  }
  return nextResolve(specifier, context);
}
