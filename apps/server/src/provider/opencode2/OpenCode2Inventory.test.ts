import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { it as viteIt } from "vite-plus/test";

import type { Agent } from "@opencode-ai/sdk/v2";

import {
  buildNextProviderList,
  flattenOpenCode2Models,
  inferDefaultAgent,
  inferDefaultVariant,
  loadOpenCode2Inventory,
  openCode2CapabilitiesForModel,
  type OpenCode2InventoryClient,
} from "./OpenCode2Inventory.ts";

interface FakeCalls {
  readonly listCalls: Array<string>;
  readonly sleeps: number;
}

function makeClient(input: {
  readonly providers?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly providerSequences?: ReadonlyArray<
    ReadonlyArray<{ readonly id: string; readonly name: string }>
  >;
  readonly models?: ReadonlyArray<{
    readonly modelID: string;
    readonly providerID: string;
    readonly name: string;
    readonly enabled?: boolean;
  }>;
  readonly modelSequences?: ReadonlyArray<
    ReadonlyArray<{
      readonly modelID: string;
      readonly providerID: string;
      readonly name: string;
      readonly enabled?: boolean;
    }>
  >;
  readonly agents?: ReadonlyArray<{
    readonly id: string;
    readonly mode?: unknown;
    readonly name?: unknown;
  }>;
  readonly agentSequences?: ReadonlyArray<
    ReadonlyArray<{ readonly id: string; readonly mode?: unknown; readonly name?: unknown }>
  >;
}): { client: OpenCode2InventoryClient; calls: FakeCalls } {
  const calls: FakeCalls = { listCalls: [], sleeps: 0 };
  let providerRound = 0;
  let modelRound = 0;
  let agentRound = 0;
  const client: OpenCode2InventoryClient = {
    provider: {
      list: async () => {
        calls.listCalls.push("provider.list");
        const sequence = input.providerSequences?.[providerRound] ?? input.providers ?? [];
        providerRound += 1;
        return { data: sequence };
      },
    },
    model: {
      list: async () => {
        calls.listCalls.push("model.list");
        const sequence = input.modelSequences?.[modelRound] ?? input.models ?? [];
        modelRound += 1;
        return {
          data: sequence.map((model) => ({
            ...model,
            enabled: model.enabled ?? true,
            variants: [],
          })),
        };
      },
    },
    agent: {
      list: async () => {
        calls.listCalls.push("agent.list");
        const sequence = input.agentSequences?.[agentRound] ?? input.agents ?? [];
        agentRound += 1;
        return {
          data: sequence.map((agent) => ({
            id: agent.id,
            ...(typeof agent.name === "string" ? { name: agent.name } : {}),
            mode: typeof agent.mode === "string" ? agent.mode : "primary",
            hidden: false,
            permissions: [],
          })),
        };
      },
    },
    skill: {
      list: async () => {
        calls.listCalls.push("skill.list");
        return { data: [] };
      },
    },
    command: {
      list: async () => {
        calls.listCalls.push("command.list");
        return { data: [] };
      },
    },
  };
  return { client, calls };
}

it.effect("derives connected providers from models while provider.list is warming", () =>
  Effect.gen(function* () {
    const { client } = makeClient({
      providers: [],
      models: [{ modelID: "gpt-5", providerID: "openai", name: "GPT-5" }],
      agents: [{ id: "build" }],
    });

    const inventory = yield* loadOpenCode2Inventory(client, "/workspace");

    NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
    NodeAssert.deepEqual(
      inventory.providerList.all.map((provider) => provider.id),
      ["openai"],
    );
    NodeAssert.deepEqual(Object.keys(inventory.providerList.all[0]?.models ?? {}), ["gpt-5"]);
  }),
);

it.effect("retries while models are empty after startup", () =>
  Effect.gen(function* () {
    const { client, calls } = makeClient({
      providers: [{ id: "openai", name: "OpenAI" }],
      modelSequences: [[], [{ modelID: "gpt-5", providerID: "openai", name: "GPT-5" }]],
      agents: [{ id: "build" }],
    });

    const fiber = yield* loadOpenCode2Inventory(client, "/workspace").pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(300));
    const inventory = yield* Fiber.join(fiber);

    NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
    NodeAssert.deepEqual(Object.keys(inventory.providerList.all[0]?.models ?? {}), ["gpt-5"]);
    NodeAssert.equal(calls.listCalls.filter((call) => call === "model.list").length, 2);
  }).pipe(Effect.provide(TestClock.layer())),
);

viteIt("buildNextProviderList skips disabled models", () => {
  const { all, connected } = buildNextProviderList(
    [],
    [
      { modelID: "gpt-5", providerID: "openai", name: "GPT-5", enabled: false, variants: [] },
      { modelID: "claude", providerID: "anthropic", name: "Claude", enabled: true, variants: [] },
    ],
  );
  NodeAssert.deepEqual(connected, ["anthropic"]);
  NodeAssert.deepEqual(
    all.map((provider) => provider.id),
    ["anthropic"],
  );
});

it.effect("flattenOpenCode2Models includes model-derived providers and sorts by name", () =>
  Effect.gen(function* () {
    const { client } = makeClient({
      providers: [{ id: "openai", name: "OpenAI" }],
      models: [
        { modelID: "zebra", providerID: "openai", name: "Zebra" },
        { modelID: "alpha", providerID: "openai", name: "Alpha" },
        // A provider seen only via model.list still counts as connected
        // (warm-up derivation), so its models flatten too.
        { modelID: "ghost", providerID: "ghost-provider", name: "Ghost" },
      ],
      agents: [{ id: "build" }],
    });

    const inventory = yield* loadOpenCode2Inventory(client, "/workspace");
    const models = flattenOpenCode2Models(inventory);

    NodeAssert.deepEqual(
      models.map((model) => model.slug),
      ["openai/alpha", "ghost-provider/ghost", "openai/zebra"],
    );
    const descriptors = models[0]?.capabilities?.optionDescriptors;
    NodeAssert.ok(descriptors !== undefined);
    NodeAssert.equal(descriptors.length, 2);
  }),
);

viteIt("agent option values use wire ids so switchAgent round-trips", () => {
  const agents = [
    // AgentInfo shape: display `name` differs from wire `id`.
    { id: "build", name: "Build", mode: "primary", hidden: false, permissions: [] },
    { id: "plan", name: "Plan", mode: "primary", hidden: false, permissions: [] },
  ] as unknown as ReadonlyArray<Agent>;
  const capabilities = openCode2CapabilitiesForModel({
    providerID: "openai",
    model: { variants: {} } as never,
    agents,
  });
  const agentDescriptor = capabilities.optionDescriptors?.find(
    (descriptor) => descriptor.id === "agent",
  );
  NodeAssert.ok(agentDescriptor !== undefined && agentDescriptor.type === "select");
  NodeAssert.deepEqual(
    agentDescriptor.options.map((option: { readonly id: string }) => option.id),
    ["build", "plan"],
  );
  NodeAssert.equal(agentDescriptor.currentValue, "build");
});

viteIt("buildNextProviderList keeps id/modelID pair and filters disabled", () => {
  const { all } = buildNextProviderList(
    [{ id: "openai", name: "OpenAI" }],
    [
      {
        modelID: "gpt-5",
        providerID: "openai",
        name: "GPT-5",
        enabled: true,
        variants: [{ id: "high" }],
      },
    ],
  );
  const entry = all[0]?.models["gpt-5"] as unknown as Record<string, unknown>;
  NodeAssert.equal(entry["id"], "gpt-5");
  NodeAssert.equal(entry["modelID"], "gpt-5");
});

it.effect("location scoping passes the project directory to every list", () =>
  Effect.gen(function* () {
    const seen: Array<{ readonly namespace: string; readonly directory: unknown }> = [];
    const scoped = (namespace: string): OpenCode2InventoryClient[keyof OpenCode2InventoryClient] =>
      ({
        list: async (location: { readonly location: { readonly directory: string } }) => {
          seen.push({ namespace, directory: location.location.directory });
          // Non-empty core triple so the warm-up retry loop is bypassed.
          if (namespace === "model") {
            return {
              data: [
                {
                  modelID: "m",
                  providerID: "p",
                  name: "M",
                  enabled: true,
                  variants: [],
                },
              ],
            };
          }
          if (namespace === "agent") {
            return { data: [{ id: "build", mode: "primary", hidden: false }] };
          }
          return { data: [] };
        },
      }) as never;
    const client = {
      provider: scoped("provider"),
      model: scoped("model"),
      agent: scoped("agent"),
      skill: scoped("skill"),
      command: scoped("command"),
    } as unknown as OpenCode2InventoryClient;
    yield* loadOpenCode2Inventory(client, "/scoped/project");
    const namespaces = seen.map((entry) => entry.namespace).sort();
    NodeAssert.deepEqual(namespaces, ["agent", "command", "model", "provider", "skill"]);
    for (const entry of seen) {
      NodeAssert.equal(entry.directory, "/scoped/project");
    }
  }),
);

it.effect("agents map id-first with name fallback", () =>
  Effect.gen(function* () {
    const { client } = makeClient({
      providers: [{ id: "openai", name: "OpenAI" }],
      models: [{ modelID: "gpt-5", providerID: "openai", name: "GPT-5" }],
      agents: [{ id: "build" }],
    });
    const inventory = yield* loadOpenCode2Inventory(client, "/workspace");
    NodeAssert.deepEqual(
      inventory.agents.map((agent) => agent.name),
      ["build"],
    );
  }),
);

viteIt("inferDefaultVariant and inferDefaultAgent mirror the legacy heuristics", () => {
  NodeAssert.equal(inferDefaultVariant("openai", ["low", "medium", "high"]), "medium");
  NodeAssert.equal(inferDefaultVariant("anthropic", ["low", "high"]), "high");
  NodeAssert.equal(inferDefaultVariant("other", ["low", "high"]), undefined);
  NodeAssert.equal(inferDefaultVariant("other", ["only"]), "only");

  const agents = [{ name: "plan" }, { name: "build" }] as unknown as ReadonlyArray<Agent>;
  NodeAssert.equal(inferDefaultAgent(agents), "build");
  // Id-shaped entries ( AgentInfo.id ) still resolve the build default.
  const idShaped = [{ id: "build", name: "Build" }] as unknown as ReadonlyArray<Agent>;
  NodeAssert.equal(inferDefaultAgent(idShaped), "Build");
  NodeAssert.equal(inferDefaultAgent([]), undefined);
});

viteIt("buildNextProviderList degrades a non-array variants payload to no variants", () => {
  const { all } = buildNextProviderList(
    [{ id: "openai", name: "OpenAI" }],
    [
      {
        modelID: "gpt-5",
        providerID: "openai",
        name: "GPT-5",
        enabled: true,
        variants: null,
      } as unknown as {
        readonly modelID: string;
        readonly providerID: string;
        readonly name: string;
        readonly enabled: boolean;
        readonly variants: ReadonlyArray<{ readonly id: string }>;
      },
    ],
  );
  NodeAssert.deepEqual(all[0]?.models["gpt-5"], {
    id: "gpt-5",
    modelID: "gpt-5",
    providerID: "openai",
    name: "GPT-5",
    variants: {},
  });
});

viteIt("openCode2CapabilitiesForModel skips agents with unusable names", () => {
  const agents = [
    { name: "build", mode: "primary", hidden: false, permission: [], options: {} },
    { name: null, mode: "primary", hidden: false, permission: [], options: {} },
    { name: "   ", mode: "primary", hidden: false, permission: [], options: {} },
  ] as unknown as ReadonlyArray<Agent>;
  const capabilities = openCode2CapabilitiesForModel({
    providerID: "openai",
    model: { variants: {} } as never,
    agents,
  });
  const agentDescriptor = capabilities.optionDescriptors?.find(
    (descriptor) => descriptor.id === "agent",
  );
  NodeAssert.ok(agentDescriptor !== undefined && agentDescriptor.type === "select");
  NodeAssert.deepEqual(
    agentDescriptor.options.map((option: { readonly id: string }) => option.id),
    ["build"],
  );
});

it.effect("loadOpenCode2Inventory drops agents with no identity or unknown mode", () =>
  Effect.gen(function* () {
    const { client } = makeClient({
      providers: [{ id: "openai", name: "OpenAI" }],
      models: [{ modelID: "gpt-5", providerID: "openai", name: "GPT-5" }],
      agents: [{ id: "build" }],
    });
    const listed = yield* Effect.promise(() =>
      client.agent.list({ location: { directory: "/w" } }),
    );
    const raw = [...listed.data] as unknown as Array<Record<string, unknown>>;
    raw.push(
      { id: "", name: "", mode: "primary", hidden: false, permissions: [] },
      { id: "future", mode: "quantum", hidden: false, permissions: [] },
    );
    const inventory = yield* loadOpenCode2Inventory(client, "/workspace");
    NodeAssert.deepEqual(
      inventory.agents.map((agent) => agent.name),
      ["build"],
    );
    // The surviving agent still feeds the capability selector without throwing.
    const models = flattenOpenCode2Models(inventory);
    NodeAssert.equal(models.length, 1);
  }),
);
