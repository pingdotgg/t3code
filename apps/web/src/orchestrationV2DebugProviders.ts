import {
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");
const DEBUG_CHECKED_AT = "1970-01-01T00:00:00.000Z";

function configRecord(config: unknown): Readonly<Record<string, unknown>> {
  return config !== null && typeof config === "object" && !Array.isArray(config)
    ? (config as Readonly<Record<string, unknown>>)
    : {};
}

function configuredModels(
  config: Readonly<Record<string, unknown>>,
): ReadonlyArray<ServerProviderModel> {
  const customModels = Array.isArray(config.customModels)
    ? config.customModels.filter(
        (model): model is string => typeof model === "string" && model.trim().length > 0,
      )
    : [];
  const slugs = [...new Set(["default", ...customModels.map((model) => model.trim())])];
  return slugs.map((slug) => ({
    slug,
    name: slug === "default" ? "Agent default" : slug,
    shortName: slug === "default" ? "Default" : slug,
    isCustom: slug !== "default",
    capabilities: null,
  }));
}

/**
 * Add V2-only ACP Registry instances to the orchestration debugger's provider catalog.
 * The regular application provider catalog remains V1-owned and is intentionally untouched.
 */
export function deriveOrchestrationV2DebugProviderSnapshots(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerInstances: ProviderInstanceConfigMap;
}): ReadonlyArray<ServerProvider> {
  const snapshots = [...input.providers];
  const indexByInstanceId = new Map<ProviderInstanceId, number>(
    snapshots.map((provider, index) => [provider.instanceId, index]),
  );

  for (const [instanceId, instance] of Object.entries(input.providerInstances)) {
    if (instance.driver !== ACP_REGISTRY_DRIVER) continue;
    const config = configRecord(instance.config);
    const agentId = typeof config.agentId === "string" ? config.agentId.trim() : "";
    if (agentId.length === 0) continue;
    const id = instanceId as ProviderInstanceId;
    const existingIndex = indexByInstanceId.get(id);
    const existing = existingIndex === undefined ? undefined : snapshots[existingIndex];
    const enabled =
      instance.enabled ?? (typeof config.enabled === "boolean" ? config.enabled : true);
    const snapshot: ServerProvider = {
      instanceId: id,
      driver: ACP_REGISTRY_DRIVER,
      displayName: instance.displayName?.trim() || `ACP: ${agentId}`,
      ...(instance.accentColor ? { accentColor: instance.accentColor } : {}),
      badgeLabel: "V2 Preview",
      showInteractionModeToggle: true,
      requiresNewThreadForModelChange: false,
      enabled,
      installed: true,
      version: null,
      status: enabled ? "ready" : "disabled",
      auth: { status: "unknown" },
      checkedAt: existing?.checkedAt ?? DEBUG_CHECKED_AT,
      message: `ACP Registry agent '${agentId}' is resolved when the V2 session starts.`,
      availability: "available",
      models: configuredModels(config),
      slashCommands: [],
      skills: [],
    };
    if (existingIndex === undefined) {
      indexByInstanceId.set(id, snapshots.length);
      snapshots.push(snapshot);
    } else {
      snapshots[existingIndex] = snapshot;
    }
  }

  return snapshots;
}
