import {
  type ModelCapabilities,
  type ProviderOptionSelection,
  type SelectProviderOptionDescriptor,
} from "@t3tools/contracts";
import {
  createModelCapabilities,
  getProviderOptionStringSelectionValue,
} from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";

/**
 * T3 Code models "how hard should the agent think" as a single select option
 * descriptor named `reasoning` (see `packages/contracts/src/model.ts`). ACP
 * providers (Cursor, Grok, Hermes) expose the same notion as a session
 * `config_option` whose id/name is "effort" or "reasoning". This module is the
 * shared bridge between the two: it discovers an effort-shaped ACP config
 * option, builds the `reasoning` descriptor for the T3 catalog, and maps a
 * stored `reasoning` selection back to the ACP `session/set_config_option`
 * call that applies it.
 *
 * The descriptor is only advertised when the ACP server actually declares an
 * effort/reasoning select option, so a toggle never appears for a CLI that
 * does not support one — no lying controls. Cursor keeps its own richer
 * capability builder (`buildCursorCapabilitiesFromConfigOptions`) which also
 * surfaces context/thinking/fast options; this module covers only the
 * reasoning option, which is all Grok and Hermes apply today.
 */

const REASONING_DESCRIPTOR_ID = "reasoning";
const REASONING_DESCRIPTOR_LABEL = "Reasoning";

interface AcpSelectConfigEntry {
  readonly value: string;
  readonly name: string;
}

function isAcpReasoningConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return (
    id === "effort" ||
    id === "reasoning" ||
    name === "effort" ||
    name === "reasoning" ||
    name.includes("effort") ||
    name.includes("reasoning")
  );
}

/** The effort/reasoning-shaped select config option, if the server declares one. */
export function findAcpReasoningConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): EffectAcpSchema.SessionConfigOption | undefined {
  if (!configOptions || configOptions.length === 0) {
    return undefined;
  }
  return configOptions.find(
    (option) => option.type === "select" && isAcpReasoningConfigOption(option),
  );
}

/**
 * Flatten the nested-or-flat ACP select options into `{value, name}` entries,
 * trimmed and de-duplicated by value. ACP select options can be parameterized
 * (a group of `{value, name}` options) or flat (`{value, name}` directly);
 * both shapes are verified against `effect-acp` and mirrored from
 * `collectSessionConfigOptionValues` in `AcpRuntimeModel.ts`.
 */
function flattenAcpSelectConfigOptions(
  configOption: EffectAcpSchema.SessionConfigOption,
): ReadonlyArray<AcpSelectConfigEntry> {
  if (configOption.type !== "select") {
    return [];
  }
  const entries: Array<AcpSelectConfigEntry> = [];
  const seen = new Set<string>();
  for (const entry of configOption.options) {
    const candidates: ReadonlyArray<AcpSelectConfigEntry> =
      "value" in entry
        ? [{ value: entry.value, name: entry.name }]
        : entry.options.map((option) => ({ value: option.value, name: option.name }));
    for (const candidate of candidates) {
      const value = candidate.value.trim();
      if (!value || seen.has(value)) {
        continue;
      }
      seen.add(value);
      const name = candidate.name.trim();
      entries.push({ value, name: name || value });
    }
  }
  return entries;
}

/**
 * Build the T3 `reasoning` select descriptor from the ACP server's declared
 * effort/reasoning config option, surfacing the CLI's native values verbatim
 * and preselecting the CLI's current value. Returns `undefined` when the
 * server declares no such option, so no toggle is advertised.
 */
export function buildAcpReasoningOptionDescriptor(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): SelectProviderOptionDescriptor | undefined {
  const reasoningConfig = findAcpReasoningConfigOption(configOptions);
  if (!reasoningConfig || reasoningConfig.type !== "select") {
    return undefined;
  }
  const values = flattenAcpSelectConfigOptions(reasoningConfig);
  if (values.length === 0) {
    return undefined;
  }
  const currentValue = reasoningConfig.currentValue?.trim() || undefined;
  const options = values.map(({ value, name }) => ({
    id: value,
    label: name,
    ...(currentValue && currentValue === value ? { isDefault: true } : {}),
  }));
  return {
    id: REASONING_DESCRIPTOR_ID,
    label: reasoningConfig.name?.trim() || REASONING_DESCRIPTOR_LABEL,
    type: "select" as const,
    options,
    ...(currentValue ? { currentValue } : {}),
  };
}

/** Capabilities carrying only the `reasoning` descriptor, or empty when none. */
export function acpReasoningCapabilities(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  const descriptor = buildAcpReasoningOptionDescriptor(configOptions);
  return createModelCapabilities({
    optionDescriptors: descriptor ? [descriptor] : [],
  });
}

/**
 * Map a stored `reasoning` selection back to the originating ACP config option
 * id and value, so the adapter can apply it via `session/set_config_option`.
 * Returns `undefined` when there is no effort-shaped option or no selection.
 */
export function resolveAcpReasoningConfigUpdate(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): { readonly configId: string; readonly value: string } | undefined {
  const reasoningConfig = findAcpReasoningConfigOption(configOptions);
  if (!reasoningConfig || reasoningConfig.type !== "select") {
    return undefined;
  }
  const requested = getProviderOptionStringSelectionValue(selections, REASONING_DESCRIPTOR_ID);
  if (!requested) {
    return undefined;
  }
  const match = flattenAcpSelectConfigOptions(reasoningConfig).find(
    (entry) => entry.value === requested || entry.name === requested,
  );
  if (!match) {
    return undefined;
  }
  return { configId: reasoningConfig.id, value: match.value };
}

/** Minimal slice of an ACP runtime that can read and write config options. */
export interface AcpReasoningConfigRuntime<Err = never> {
  readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, Err>;
}

/**
 * Apply a stored `reasoning` selection to the live ACP session by issuing
 * `session/set_config_option` for the originating config option. Returns the
 * applied reasoning value so the adapter can echo it as `effort` on the wire.
 * No-ops when the server declares no effort option or the selection is absent.
 *
 * Generic over the runtime's error type (`Err`) so the adapter's `mapError`
 * receives the concrete ACP error and can fold it into its own error type.
 */
export function applyAcpReasoningConfig<E, Err>(input: {
  readonly runtime: AcpReasoningConfigRuntime<Err>;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (cause: Err) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    const configOptions = yield* input.runtime.getConfigOptions;
    const update = resolveAcpReasoningConfigUpdate(configOptions, input.selections);
    if (!update) {
      return undefined;
    }
    yield* input.runtime
      .setConfigOption(update.configId, update.value)
      .pipe(Effect.mapError(input.mapError));
    return update.value;
  });
}
