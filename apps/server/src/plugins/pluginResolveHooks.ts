let pluginsRootUrl = "";
let hostAnchorUrl: string | undefined;

export function initialize(data: unknown) {
  if (data && typeof data === "object") {
    const value = (data as { readonly pluginsRootUrl?: unknown }).pluginsRootUrl;
    if (typeof value === "string") {
      pluginsRootUrl = value.endsWith("/") ? value : `${value}/`;
    }
    const anchor = (data as { readonly hostAnchorUrl?: unknown }).hostAnchorUrl;
    if (typeof anchor === "string") {
      hostAnchorUrl = anchor;
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
    // `import.meta.resolve` is not available inside the ESM loader-hook worker.
    // Re-anchor the resolution to a host module so Node's resolver finds the
    // host's `effect`/SDK (handles bare packages AND arbitrary subpaths), keeping
    // the plugin on the host's singleton instances.
    return nextResolve(specifier, { parentURL: hostAnchorUrl ?? context.parentURL });
  }
  return nextResolve(specifier, context);
}
