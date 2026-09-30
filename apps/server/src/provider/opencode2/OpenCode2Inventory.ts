import type { Agent, ProviderListResponse } from "@opencode-ai/sdk/v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import type { OpenCodeInventory, OpenCodeSkill, OpenCodeSlashCommand } from "../opencodeRuntime.ts";
import { nonEmptyTrimmed } from "../providerSnapshot.ts";

/**
 * The OpenCode 2 provider inventory, normalized into the shared
 * {@link OpenCodeInventory} contract so both generations share one downstream
 * shape. The only place that knows the V2 list-endpoint surface is the narrow
 * {@link OpenCode2InventoryClient} interface below; everything downstream
 * consumes legacy-shaped inventory.
 */
export type OpenCode2Inventory = OpenCodeInventory;

export class OpenCode2InventoryError extends Data.TaggedError("OpenCode2InventoryError")<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// V2 list-endpoint surface (structural; mirrors `@opencode/client` list calls)
// ---------------------------------------------------------------------------

export interface OpenCode2ListLocation {
  readonly location: { readonly directory: string };
}

export interface OpenCode2ListOptions {
  readonly signal?: AbortSignal;
}

export interface OpenCode2ProviderSummary {
  readonly id: string;
  readonly name: string;
}

export interface OpenCode2ModelVariant {
  readonly id: string;
}

export interface OpenCode2ModelSummary {
  readonly modelID: string;
  readonly providerID: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly variants: ReadonlyArray<OpenCode2ModelVariant>;
}

export interface OpenCode2AgentSummary {
  readonly id: string;
  readonly name?: string;
  readonly mode: string;
  readonly hidden: boolean;
  readonly permissions: unknown;
}

export interface OpenCode2SkillSummary {
  readonly name: string;
  readonly description?: string;
  readonly path: string;
}

export interface OpenCode2CommandSummary {
  readonly name: string;
  readonly description?: string;
}

interface OpenCode2ListNamespace<T> {
  readonly list: (
    location: OpenCode2ListLocation,
    options?: OpenCode2ListOptions,
  ) => Promise<{ readonly data: ReadonlyArray<T> }>;
}

export interface OpenCode2InventoryClient {
  readonly provider: OpenCode2ListNamespace<OpenCode2ProviderSummary>;
  readonly model: OpenCode2ListNamespace<OpenCode2ModelSummary>;
  readonly agent: OpenCode2ListNamespace<OpenCode2AgentSummary>;
  readonly skill: OpenCode2ListNamespace<OpenCode2SkillSummary>;
  readonly command: OpenCode2ListNamespace<OpenCode2CommandSummary>;
}

// ---------------------------------------------------------------------------
// Provider list construction
// ---------------------------------------------------------------------------

/**
 * OpenCode 2 warms its provider list asynchronously: right after startup
 * `provider.list` can be empty while `model.list` already reflects the
 * configured providers. Derive the connected set from both so the model
 * inventory is populated immediately. Only enabled models contribute.
 *
 * Location scoping: every list takes `{location: {directory}}`; the SDK
 * input itself is optional (server-global fallback), but the inventory
 * always passes the project directory so results reflect the project that
 * owns the thread.
 *
 * Connected derivation mirrors core's availability rule
 * (core/src/provider.ts): a provider counts as connected unless its
 * activation is `"disabled"`. `provider.list` does not surface an
 * activation field, so every listed provider joins `connected`, and every
 * enabled model pulls its provider in too (the warm-up case). Disabled
 * models never contribute. Models for providers absent from both lists are
 * still flattened when their provider id is model-derived.
 */
export function buildNextProviderList(
  providers: ReadonlyArray<OpenCode2ProviderSummary>,
  models: ReadonlyArray<OpenCode2ModelSummary>,
): { all: ProviderListResponse["all"]; connected: Array<string> } {
  const meta = new Map(providers.map((provider) => [provider.id, provider]));
  const connected = providers.map((provider) => provider.id);
  const seen = new Set(connected);
  const modelsByProvider = new Map<string, Record<string, unknown>>();
  for (const model of models) {
    if (!model.enabled) {
      continue;
    }
    // List payloads are server data: a non-array `variants` (or any other
    // forward-compat shape) degrades to no variants instead of throwing.
    const variants = Array.isArray(model.variants) ? model.variants : [];
    if (!seen.has(model.providerID)) {
      seen.add(model.providerID);
      connected.push(model.providerID);
    }
    const bucket = modelsByProvider.get(model.providerID) ?? {};
    bucket[model.modelID] = {
      // `id` is the wire identity (Model.Info.id); `modelID` equals it for
      // configured models (Model.Info.default sets modelID: id). Keep both
      // so slug parsing (`provider/modelID`) and id-keyed lookups agree.
      id: model.modelID,
      modelID: model.modelID,
      providerID: model.providerID,
      name: model.name,
      variants: Object.fromEntries(variants.map((variant) => [variant.id, {}])),
    };
    modelsByProvider.set(model.providerID, bucket);
  }
  const all = connected.map((id) => ({
    id,
    name: meta.get(id)?.name ?? id,
    source: "config" as const,
    env: [] as Array<string>,
    options: {} as Record<string, unknown>,
    models: (modelsByProvider.get(id) ?? {}) as ProviderListResponse["all"][number]["models"],
  }));
  return { all, connected };
}

/** Mirrors the legacy provider's default-variant heuristic. */
export function inferDefaultVariant(
  providerID: string,
  variants: ReadonlyArray<string>,
): string | undefined {
  if (variants.length === 1) {
    return variants[0];
  }
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "openai" || providerID === "opencode") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

/** Mirrors the legacy provider's default-agent heuristic. */
export function inferDefaultAgent(
  agents: ReadonlyArray<{ readonly id?: string; readonly name: string }>,
): string | undefined {
  return (
    agents.find((agent) => agent.name === "build")?.name ??
    agents.find((agent) => agent.id === "build")?.name ??
    agents[0]?.name ??
    undefined
  );
}

function titleCaseSlug(value: string): string {
  const segments: Array<string> = [];
  for (const segment of value.split(/[-_/]+/)) {
    if (segment.length > 0) {
      segments.push(segment.charAt(0).toUpperCase() + segment.slice(1));
    }
  }
  return segments.join(" ");
}

/** Variant + agent capability descriptors, mirroring the legacy provider. */
export function openCode2CapabilitiesForModel(input: {
  readonly providerID: string;
  readonly model: ProviderListResponse["all"][number]["models"][string];
  readonly agents: ReadonlyArray<Agent>;
}): ModelCapabilities {
  const rawVariantValues = Object.keys(input.model.variants ?? {});
  // When a model advertises no variants, synthesize the standard reasoning
  // levels so the composer still offers a Reasoning selector. `inferDefaultVariant`
  // picks the provider-appropriate default (e.g. medium for openai/opencode).
  const variantValues =
    rawVariantValues.length > 0 ? rawVariantValues : ["low", "medium", "high", "xhigh"];
  const defaultVariant = inferDefaultVariant(input.providerID, variantValues);
  const variantOptions = variantValues.map((value) =>
    defaultVariant === value
      ? { id: value, label: titleCaseSlug(value), isDefault: true as const }
      : { id: value, label: titleCaseSlug(value) },
  );
  const primaryAgents = input.agents.filter(
    (agent) =>
      !agent.hidden &&
      (agent.mode === "primary" || agent.mode === "all") &&
      typeof agent.name === "string" &&
      agent.name.trim().length > 0,
  );
  // Agent ids are wire identities (Agent.Info.id; built-ins keyed by id,
  // e.g. `build`), while `session.switchAgent` takes
  // `agent: Agent.ID` — the id, not the display name (`Build`). Expose the
  // id as the option value and keep the name as the label so the selected
  // value round-trips through switchAgent.
  const withIds = primaryAgents.map((agent) => {
    const record = agent as unknown as Record<string, unknown>;
    const id =
      typeof record["id"] === "string" && record["id"].trim().length > 0
        ? record["id"]
        : agent.name;
    return { id, name: agent.name };
  });
  const defaultAgent = inferDefaultAgent(withIds);
  const defaultAgentId = withIds.find((entry) => entry.name === defaultAgent)?.id;
  const agentOptions = withIds.map((entry) =>
    defaultAgentId === entry.id
      ? { id: entry.id, label: titleCaseSlug(entry.name), isDefault: true as const }
      : { id: entry.id, label: titleCaseSlug(entry.name) },
  );
  return createModelCapabilities({
    optionDescriptors: [
      ...(variantOptions.length > 0
        ? [
            {
              id: "variant",
              label: "Reasoning",
              type: "select" as const,
              options: variantOptions,
              ...(defaultVariant ? { currentValue: defaultVariant } : {}),
            },
          ]
        : []),
      ...(agentOptions.length > 0
        ? [
            {
              id: "agent",
              label: "Agent",
              type: "select" as const,
              options: agentOptions,
              ...(defaultAgentId ? { currentValue: defaultAgentId } : {}),
            },
          ]
        : []),
    ],
  });
}

/** Flattens connected-provider models into sorted server provider models. */
export function flattenOpenCode2Models(
  input: OpenCode2Inventory,
): ReadonlyArray<ServerProviderModel> {
  const connected = new Set(input.providerList.connected);
  const models: Array<ServerProviderModel> = [];

  for (const provider of input.providerList.all) {
    if (!connected.has(provider.id)) {
      continue;
    }

    for (const model of Object.values(provider.models)) {
      const name = nonEmptyTrimmed(model.name);
      if (!name) {
        continue;
      }

      const subProvider = nonEmptyTrimmed(provider.name);
      models.push({
        slug: `${provider.id}/${model.id}`,
        name,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        capabilities: openCode2CapabilitiesForModel({
          providerID: provider.id,
          model,
          agents: input.agents,
        }),
      });
    }
  }

  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

// ---------------------------------------------------------------------------
// Inventory loading with warm-up retry
// ---------------------------------------------------------------------------

const failInventory = (operation: string, detail: string, cause: unknown) =>
  new OpenCode2InventoryError({ operation, detail, cause });

const listProviders = (client: OpenCode2InventoryClient, location: OpenCode2ListLocation) =>
  Effect.tryPromise({
    try: (signal) => client.provider.list(location, { signal }),
    catch: (cause) => failInventory("provider.list", "OpenCode 2 provider.list failed.", cause),
  }).pipe(Effect.map((result) => result.data));

const listModels = (client: OpenCode2InventoryClient, location: OpenCode2ListLocation) =>
  Effect.tryPromise({
    try: (signal) => client.model.list(location, { signal }),
    catch: (cause) => failInventory("model.list", "OpenCode 2 model.list failed.", cause),
  }).pipe(Effect.map((result) => result.data));

const listAgents = (client: OpenCode2InventoryClient, location: OpenCode2ListLocation) =>
  Effect.tryPromise({
    try: (signal) => client.agent.list(location, { signal }),
    catch: (cause) => failInventory("agent.list", "OpenCode 2 agent.list failed.", cause),
  }).pipe(
    Effect.map((result) => result.data),
    Effect.orElseSucceed((): ReadonlyArray<OpenCode2AgentSummary> => []),
  );

const listSkills = (client: OpenCode2InventoryClient, location: OpenCode2ListLocation) =>
  Effect.tryPromise({
    try: (signal) => client.skill.list(location, { signal }),
    catch: (cause) => failInventory("skill.list", "OpenCode 2 skill.list failed.", cause),
  }).pipe(
    Effect.map((result): ReadonlyArray<OpenCodeSkill> =>
      result.data.map((skill) => ({
        name: skill.name,
        ...(skill.description === undefined ? {} : { description: skill.description }),
        location: skill.path,
      })),
    ),
    Effect.orElseSucceed((): ReadonlyArray<OpenCodeSkill> => []),
  );

const listCommands = (client: OpenCode2InventoryClient, location: OpenCode2ListLocation) =>
  Effect.tryPromise({
    try: (signal) => client.command.list(location, { signal }),
    catch: (cause) => failInventory("command.list", "OpenCode 2 command.list failed.", cause),
  }).pipe(
    Effect.map((result): ReadonlyArray<OpenCodeSlashCommand> =>
      result.data.map((command) => ({
        name: command.name,
        ...(command.description === undefined ? {} : { description: command.description }),
        hints: [],
      })),
    ),
    Effect.orElseSucceed((): ReadonlyArray<OpenCodeSlashCommand> => []),
  );

/**
 * Loads provider/model/agent/skill/command inventory from an OpenCode 2 server
 * and normalizes it into the shared inventory contract.
 *
 * OpenCode 2 populates its inventory asynchronously in the first moments after
 * startup, so an empty model or agent list triggers a brief retry before the
 * inventory is accepted as genuinely empty. The retry re-fetches the whole
 * core triple, then re-checks: a provider-only warm-up (provider.list
 * populated, model.list empty) still retries, while a provider that reports
 * zero models after the budget is accepted as genuinely empty. Ten attempts
 * at 300ms (3s budget) covers the observed cold-start window; overshooting
 * only delays the provider snapshot, never fails it.
 */
export const loadOpenCode2Inventory = Effect.fn("loadOpenCode2Inventory")(function* (
  client: OpenCode2InventoryClient,
  directory: string,
): Effect.fn.Return<OpenCode2Inventory, OpenCode2InventoryError> {
  const location = { location: { directory } };
  const loadCore = Effect.all(
    [listProviders(client, location), listModels(client, location), listAgents(client, location)],
    {
      concurrency: "unbounded",
    },
  );

  let [providers, models, agents] = yield* loadCore;
  for (
    let attempt = 0;
    attempt < 10 && (models.length === 0 || agents.length === 0);
    attempt += 1
  ) {
    yield* Effect.sleep("300 millis");
    [providers, models, agents] = yield* loadCore;
  }

  const [skills, commands] = yield* Effect.all(
    [listSkills(client, location), listCommands(client, location)],
    { concurrency: "unbounded" },
  );

  const { all, connected } = buildNextProviderList(providers, models);

  return {
    providerList: { all, default: {}, connected },
    agents: agents.flatMap((agent): ReadonlyArray<Agent> => {
      // AgentInfo carries both `id` (wire identity, e.g. `build`) and
      // `name` (display, e.g. `Build`); the shared Agent contract keys on
      // one `name`. Prefer the id so capability values and switchAgent
      // agree, falling back to name for forward-compat shapes. Both are
      // server data: skip entries with no usable identity or an unknown
      // mode instead of building an Agent that fails downstream validation
      // (or throwing in `titleCaseSlug` via a non-string name).
      const identity = nonEmptyTrimmed(agent.id) ?? nonEmptyTrimmed(agent.name);
      if (identity === undefined) return [];
      if (agent.mode !== "subagent" && agent.mode !== "primary" && agent.mode !== "all") {
        return [];
      }
      return [
        {
          name: identity,
          mode: agent.mode,
          hidden: agent.hidden,
          permission: agent.permissions,
          options: {},
        } as unknown as Agent,
      ];
    }),
    skills,
    commands,
  } satisfies OpenCodeInventory;
});
