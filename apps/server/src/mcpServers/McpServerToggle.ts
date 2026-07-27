/**
 * McpServerToggle — persist the T3-owned disable list for a provider
 * instance's MCP servers.
 *
 * The list lives in the instance's own settings blob so it travels with the
 * instance and is applied at session launch. Writes target whichever store
 * actually holds the instance: an explicit `providerInstances` entry, or the
 * legacy per-driver `providers.<kind>` mirror the default instance still uses.
 *
 * @module mcpServers/McpServerToggle
 */
import type {
  ProviderInstanceConfig,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { defaultInstanceIdForDriver, ProviderInstanceId } from "@t3tools/contracts";

type DisabledMcpServersWriteTarget =
  | { readonly kind: "instance"; readonly patch: ServerSettingsPatch }
  | { readonly kind: "legacyProvider"; readonly patch: ServerSettingsPatch }
  | { readonly kind: "unsupported" };

/** Drivers whose settings schema carries `disabledMcpServers`. */
const TOGGLEABLE_DRIVERS = new Set(["claudeAgent", "codex"]);

function readDisabledMcpServers(config: unknown): ReadonlyArray<string> {
  if (typeof config !== "object" || config === null) return [];
  const value = (config as { readonly disabledMcpServers?: unknown }).disabledMcpServers;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** Add or remove `name`, preserving order and rejecting duplicates. */
export function nextDisabledMcpServers(
  current: ReadonlyArray<string>,
  name: string,
  enabled: boolean,
): ReadonlyArray<string> {
  if (enabled) return current.filter((entry) => entry !== name);
  return current.includes(name) ? current : [...current, name];
}

/**
 * Build the settings patch that flips one server for one instance. Returns
 * `unsupported` when the instance is unknown or its driver has no disable
 * list, so the caller can answer with an invalid-request rather than writing
 * settings that would never be read back.
 */
export function planDisabledMcpServersWrite(
  settings: ServerSettings,
  input: { readonly instanceId: string; readonly name: string; readonly enabled: boolean },
): DisabledMcpServersWriteTarget {
  const explicit: ProviderInstanceConfig | undefined =
    settings.providerInstances[ProviderInstanceId.make(input.instanceId)];
  if (explicit) {
    if (!TOGGLEABLE_DRIVERS.has(explicit.driver)) return { kind: "unsupported" };
    const config = (explicit.config ?? {}) as Record<string, unknown>;
    const disabledMcpServers = nextDisabledMcpServers(
      readDisabledMcpServers(config),
      input.name,
      input.enabled,
    );
    return {
      kind: "instance",
      patch: {
        providerInstances: {
          ...settings.providerInstances,
          [input.instanceId]: {
            ...explicit,
            config: { ...config, disabledMcpServers: [...disabledMcpServers] },
          },
        },
      } as ServerSettingsPatch,
    };
  }

  for (const driver of TOGGLEABLE_DRIVERS) {
    if (defaultInstanceIdForDriver(driver as never) !== input.instanceId) continue;
    const legacyKey = driver as keyof ServerSettings["providers"];
    const legacyConfig = settings.providers[legacyKey];
    if (legacyConfig === undefined) return { kind: "unsupported" };
    const disabledMcpServers = nextDisabledMcpServers(
      readDisabledMcpServers(legacyConfig),
      input.name,
      input.enabled,
    );
    return {
      kind: "legacyProvider",
      patch: {
        providers: {
          [legacyKey]: { disabledMcpServers: [...disabledMcpServers] },
        },
      } as ServerSettingsPatch,
    };
  }

  return { kind: "unsupported" };
}
