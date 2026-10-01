import { valid, validRange, satisfies } from "semver";
import type {
  ApiDefinition,
  ApiRequirement,
  ApiSelection,
  ApiUnavailableReason,
  PluginDependency,
} from "@t3tools/extension-sdk/capabilities";

export interface ResolutionInstallation {
  readonly id: string;
  readonly enabled: boolean;
  readonly package: {
    readonly manifest: { readonly version: string };
    readonly dependencies?: readonly PluginDependency[];
    readonly provides?: readonly ApiDefinition[];
    readonly requires?: readonly ApiRequirement[];
  };
}
export interface ResolutionProvider {
  readonly providerId: string;
  readonly pluginId?: string;
  readonly definition: ApiDefinition;
  readonly health?: "ready" | "starting" | "failed" | "unavailable";
}
export interface PluginResolution {
  readonly id: string;
  readonly status: "available" | "disabled" | "unavailable";
  readonly reason?: ApiUnavailableReason;
}
export interface ApiResolution {
  readonly id: string;
  readonly providerId?: string;
  readonly reason?: ApiUnavailableReason;
}
export interface CapabilityResolution {
  readonly plugins: readonly PluginResolution[];
  readonly apis: readonly ApiResolution[];
  readonly order: readonly string[];
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const reason = (
  code: string,
  detail: string,
  relatedIds: readonly string[] = [],
): ApiUnavailableReason => ({ code, detail, relatedIds: [...relatedIds].sort(compare) });
function range(value: string) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    validRange(value) === null
  )
    throw new Error("Invalid capability version range");
}
function version(value: string) {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    valid(value) === null ||
    !/^[0-9]+[.][0-9]+[.][0-9]+(?:-[0-9A-Za-z.-]+)?(?:[+][0-9A-Za-z.-]+)?$/.test(value)
  )
    throw new Error("Invalid capability version");
}
/** Graph eligibility only. Runtime handshake and per-call authorization remain separate. */
export function resolveCapabilities(input: {
  readonly installations: readonly ResolutionInstallation[];
  readonly pluginHealth?: Readonly<Record<string, "ready" | "starting" | "failed" | "unavailable">>;
  readonly providers?: readonly ResolutionProvider[];
  readonly selections?: readonly ApiSelection[];
}): CapabilityResolution {
  const installations = [...input.installations].sort((a, b) => compare(a.id, b.id));
  const records = new Map<string, ResolutionInstallation>();
  const states = new Map<string, PluginResolution>();
  const edges = new Map<string, Set<string>>();
  for (const item of installations) {
    if (records.has(item.id)) throw new Error("Duplicate installation identity");
    version(item.package.manifest.version);
    records.set(item.id, item);
    edges.set(item.id, new Set());
    const health = input.pluginHealth?.[item.id];
    states.set(
      item.id,
      !item.enabled
        ? { id: item.id, status: "disabled" }
        : health === "failed" || health === "unavailable"
          ? {
              id: item.id,
              status: "unavailable",
              reason: reason(
                health === "failed" ? "failed-plugin" : "provider-unavailable",
                "Plugin execution is unavailable",
                [item.id],
              ),
            }
          : { id: item.id, status: "available" },
    );
    const dependencies = new Set<string>();
    for (const dependency of item.package.dependencies ?? []) {
      range(dependency.versionRange);
      if (dependencies.has(dependency.pluginId)) throw new Error("Duplicate dependency");
      dependencies.add(dependency.pluginId);
      const apis = new Set<string>();
      for (const api of dependency.apis) {
        range(api.versionRange);
        if (apis.has(api.id)) throw new Error("Duplicate dependency API");
        apis.add(api.id);
      }
    }
    const requires = new Set<string>();
    for (const api of item.package.requires ?? []) {
      range(api.versionRange);
      if (requires.has(api.id)) throw new Error("Duplicate API requirement");
      requires.add(api.id);
    }
  }
  const providers: ResolutionProvider[] = [
    ...(input.providers ?? []),
    ...installations.flatMap((item) =>
      (item.package.provides ?? []).map((definition) => ({
        providerId: item.id,
        pluginId: item.id,
        definition,
      })),
    ),
  ].sort(
    (a, b) => compare(a.definition.id, b.definition.id) || compare(a.providerId, b.providerId),
  );
  const providerKeys = new Set<string>();
  for (const provider of providers) {
    version(provider.definition.version);
    const key = JSON.stringify([provider.definition.id, provider.providerId]);
    if (providerKeys.has(key)) throw new Error("Duplicate API provider");
    providerKeys.add(key);
    if (provider.pluginId && !records.has(provider.pluginId))
      throw new Error("Provider plugin is not installed");
  }
  const selections = new Map<string, ApiSelection>();
  for (const item of input.selections ?? []) {
    if (
      selections.has(item.id) ||
      new Set([item.providerId, ...item.fallbackProviderIds]).size !==
        item.fallbackProviderIds.length + 1
    )
      throw new Error("Duplicate API selection or fallback");
    selections.set(item.id, item);
  }
  const fail = (id: string, unavailable: ApiUnavailableReason) => {
    if (states.get(id)?.status === "available")
      states.set(id, { id, status: "unavailable", reason: unavailable });
  };
  for (const item of installations) {
    if (!item.enabled) continue;
    for (const dependency of [...(item.package.dependencies ?? [])].sort((a, b) =>
      compare(a.pluginId, b.pluginId),
    )) {
      const target = records.get(dependency.pluginId);
      if (!target) {
        fail(
          item.id,
          reason("missing-dependency", "Required plugin is not installed", [dependency.pluginId]),
        );
        continue;
      }
      edges.get(item.id)!.add(target.id);
      if (!target.enabled)
        fail(item.id, reason("disabled-dependency", "Required plugin is disabled", [target.id]));
      else if (!satisfies(target.package.manifest.version, dependency.versionRange))
        fail(
          item.id,
          reason("incompatible-dependency", "Required plugin version is incompatible", [target.id]),
        );
      for (const requirement of [...dependency.apis].sort((a, b) => compare(a.id, b.id))) {
        const api = target.package.provides?.find((candidate) => candidate.id === requirement.id);
        if (!api)
          fail(
            item.id,
            reason("missing-api", "Dependency does not provide required API", [
              target.id,
              requirement.id,
            ]),
          );
        else if (!satisfies(api.version, requirement.versionRange))
          fail(
            item.id,
            reason("incompatible-api", "Dependency API version is incompatible", [
              target.id,
              requirement.id,
            ]),
          );
      }
    }
  }
  const healthy = (provider: ResolutionProvider) =>
    (!provider.health || provider.health === "ready") &&
    (!provider.pluginId || states.get(provider.pluginId)?.status === "available");
  const apiIds = [
    ...new Set([
      ...providers.map((item) => item.definition.id),
      ...selections.keys(),
      ...installations.flatMap((item) => (item.package.requires ?? []).map((api) => api.id)),
    ]),
  ].sort(compare);
  const chosen = new Map<string, ResolutionProvider>();
  const apiStates = new Map<string, ApiResolution>();
  for (const id of apiIds) {
    const candidates = providers.filter((provider) => provider.definition.id === id);
    const selection = selections.get(id);
    let selected: ResolutionProvider | undefined;
    let unavailable: ApiUnavailableReason | undefined;
    if (selection) {
      selected = [selection.providerId, ...selection.fallbackProviderIds]
        .map((providerId) =>
          candidates.find((candidate) => candidate.providerId === providerId && healthy(candidate)),
        )
        .find((candidate) => candidate !== undefined);
      if (!selected)
        unavailable = reason(
          "selected-provider-unavailable",
          "Selected provider and configured fallbacks are unavailable",
          [selection.providerId],
        );
    } else {
      const eligible = candidates.filter(healthy);
      if (eligible.length === 1) selected = eligible[0];
      else
        unavailable = reason(
          eligible.length > 1 ? "provider-selection-required" : "missing-api",
          eligible.length > 1
            ? "Multiple providers require explicit selection"
            : "No available API provider",
          eligible.map((candidate) => candidate.providerId),
        );
    }
    if (selected) {
      chosen.set(id, selected);
      apiStates.set(id, { id, providerId: selected.providerId });
    } else apiStates.set(id, { id, reason: unavailable! });
  }
  for (const item of installations) {
    if (!item.enabled) continue;
    for (const requirement of [...(item.package.requires ?? [])].sort((a, b) =>
      compare(a.id, b.id),
    )) {
      const provider = chosen.get(requirement.id);
      if (!provider) {
        fail(item.id, apiStates.get(requirement.id)!.reason!);
        continue;
      }
      if (!satisfies(provider.definition.version, requirement.versionRange))
        fail(
          item.id,
          reason("incompatible-api", "Selected API version is incompatible", [
            requirement.id,
            provider.providerId,
          ]),
        );
      if (provider.pluginId) edges.get(item.id)!.add(provider.pluginId);
    }
  }
  // Tarjan includes provider edges, so an apparently unrelated API selection cannot hide a cycle.
  let counter = 0;
  const indices = new Map<string, number>(),
    low = new Map<string, number>();
  const stack: string[] = [],
    stacked = new Set<string>();
  const visit = (id: string) => {
    indices.set(id, counter);
    low.set(id, counter++);
    stack.push(id);
    stacked.add(id);
    for (const dependency of [...edges.get(id)!].sort(compare)) {
      if (!indices.has(dependency)) {
        visit(dependency);
        low.set(id, Math.min(low.get(id)!, low.get(dependency)!));
      } else if (stacked.has(dependency))
        low.set(id, Math.min(low.get(id)!, indices.get(dependency)!));
    }
    if (low.get(id) === indices.get(id)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        stacked.delete(member);
        component.push(member);
      } while (member !== id);
      if (component.length > 1 || edges.get(id)!.has(id))
        for (const member of component)
          if (records.get(member)!.enabled)
            states.set(member, {
              id: member,
              status: "unavailable",
              reason: reason("cyclic-dependency", "Dependency graph contains a cycle", component),
            });
    }
  };
  for (const item of installations) if (!indices.has(item.id)) visit(item.id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of installations) {
      if (states.get(item.id)!.status !== "available") continue;
      const unavailable = [...edges.get(item.id)!]
        .sort(compare)
        .find((dependency) => states.get(dependency)!.status !== "available");
      if (unavailable) {
        fail(
          item.id,
          reason("dependency-unavailable", "Required plugin is unavailable", [
            unavailable,
            ...(states.get(unavailable)!.reason?.relatedIds ?? []),
          ]),
        );
        changed = true;
      }
    }
  }
  for (const [id, provider] of chosen)
    if (!healthy(provider))
      apiStates.set(id, {
        id,
        reason: reason("selected-provider-unavailable", "Resolved provider is unavailable", [
          provider.providerId,
        ]),
      });
  const order: string[] = [],
    remaining = new Set(
      installations
        .filter((item) => states.get(item.id)!.status === "available")
        .map((item) => item.id),
    );
  while (remaining.size) {
    const next = [...remaining]
      .sort(compare)
      .find((id) => [...edges.get(id)!].every((dependency) => !remaining.has(dependency)));
    if (!next) throw new Error("Unresolved dependency cycle");
    remaining.delete(next);
    order.push(next);
  }
  return {
    plugins: installations.map((item) => states.get(item.id)!),
    apis: apiIds.map((id) => apiStates.get(id)!),
    order,
  };
}
