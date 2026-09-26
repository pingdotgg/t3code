import type {
  ApiClient,
  ApiSelection,
  ApiUnavailableReason,
} from "@t3tools/extension-sdk/capabilities";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";

export interface InstalledApiPolicy {
  readonly apiSelections: readonly ApiSelection[];
  readonly apiResolution: readonly {
    readonly id: string;
    readonly providerId?: string;
    readonly reason?: ApiUnavailableReason;
  }[];
}
const policies = new Map<string, InstalledApiPolicy>();
export function setInstalledApiPolicy(environmentId: string, policy: InstalledApiPolicy | null) {
  if (policy) policies.set(environmentId, policy);
  else policies.delete(environmentId);
  changed();
}
const clients = new Map<string, Map<string, ApiClient>>();
const listeners = new Set<() => void>();
let revision = 0;
const clientRevisions = new WeakMap<ApiClient, number>();
/** A stable signature for this API's selected provider, not every installation in the app. */
export function installedApiSelectionRevision(environmentId: string, apiId: string) {
  const policy = policies.get(environmentId);
  const resolution = policy?.apiResolution.find((api) => api.id === apiId);
  const selection = policy?.apiSelections.find((api) => api.id === apiId);
  const environment = clients.get(environmentId);
  const relevantIds = resolution?.providerId
    ? [resolution.providerId]
    : (resolution?.reason?.relatedIds ??
      (selection
        ? [selection.providerId, ...selection.fallbackProviderIds]
        : policy
          ? []
          : [...(environment?.keys() ?? [])]));
  return JSON.stringify([
    resolution ?? null,
    selection ?? null,
    [...new Set(relevantIds)].sort().map((id) => {
      const client = environment?.get(id);
      return [id, client ? (clientRevisions.get(client) ?? null) : null];
    }),
  ]);
}
function changed() {
  revision++;
  for (const listener of listeners) listener();
}
export const subscribeInstalledApiClients = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const installedApiClientRevision = () => revision;

/** Only successfully installed, hash-bound client sessions enter this registry. */
export function registerInstalledApiClient(
  environmentId: string,
  pluginId: string,
  client: ApiClient,
) {
  let environment = clients.get(environmentId);
  if (!environment) {
    environment = new Map();
    clients.set(environmentId, environment);
  }
  if (environment.has(pluginId)) throw new Error("Installed API client already registered");
  environment.set(pluginId, client);
  clientRevisions.set(client, revision + 1);
  changed();
  return () => {
    if (environment.get(pluginId) !== client) return;
    environment.delete(pluginId);
    if (!environment.size) clients.delete(environmentId);
    changed();
  };
}

/**
 * No provider can serve the API and none was chosen — e.g. the only provider's
 * plugin is disabled. That is the same as no installation naming the API, so
 * the caller's in-tree fallback renders instead of an error.
 */
const noProvider = (
  reason: ApiUnavailableReason | undefined,
  selection: ApiSelection | undefined,
) => reason?.code === "missing-api" && selection === undefined;

/** Selection is host policy. Registration order never chooses an API provider. */
export async function resolveInstalledApiProvider(
  id: string,
  context: ViewContext,
  signal: AbortSignal,
) {
  const policy = policies.get(context.resource.environmentId);
  const resolution = policy?.apiResolution.find((item) => item.id === id);
  const selection = policy?.apiSelections.find((item) => item.id === id);
  const environment = clients.get(context.resource.environmentId);
  if (!environment?.size) {
    if (noProvider(resolution?.reason, selection)) return null;
    if (resolution?.reason) throw new Error(resolution.reason.detail);
    if (resolution?.providerId || selection)
      throw new Error("Selected API provider client is unavailable");
    return null;
  }
  const capturedRevision = installedApiSelectionRevision(context.resource.environmentId, id);
  // Every client discovers the host catalogue. Selected APIs use their provider
  // caller scope; unrelated clients must not delay the presentation.
  const providerId = resolution?.providerId ?? selection?.providerId;
  const discoveryClient = providerId
    ? (environment.get(providerId) ??
      selection?.fallbackProviderIds
        .map((fallback) => environment.get(fallback))
        .find((client) => client !== undefined))
    : environment.values().next().value;
  if (!discoveryClient)
    throw new Error(resolution?.reason?.detail ?? "Selected API provider client is unavailable");
  const discoveries = await Promise.allSettled([discoveryClient.discoverApis(context, signal)]);
  signal.throwIfAborted();
  if (installedApiSelectionRevision(context.resource.environmentId, id) !== capturedRevision)
    throw new Error("Installed API clients changed during discovery");
  if (discoveries.every((result) => result.status === "rejected"))
    throw new Error("API discovery is unavailable in this scope");
  const available = discoveries.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  const selected = available.find((item) => item.id === id && item.selected);
  if (!selected) {
    const reason = available.find((item) => item.id === id)?.reason ?? resolution?.reason;
    if (noProvider(reason, selection)) return null;
    if (reason) throw new Error(reason.detail);
    if (resolution?.providerId || selection)
      throw new Error("Selected API provider is unavailable");
    if (available.some((item) => item.id === id))
      throw new Error("API provider selection is required");
    return null;
  }
  if (selected.health === "unavailable" || selected.health === "failed")
    throw new Error(selected.reason?.detail ?? "Selected API provider is unavailable");
  if (!selected.pluginId)
    throw new Error("Selected presentation provider is not an installed plugin");
  const client = environment.get(selected.pluginId);
  if (!client) throw new Error("Selected API provider client is unavailable");
  return { client, discovery: selected };
}
