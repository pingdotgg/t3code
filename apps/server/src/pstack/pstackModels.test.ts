import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../provider/ClaudeModelCatalog.ts";
import { formatPstackBlock, parseModelsFile, resolveRoles } from "./pstackModels.ts";

const effort = (id: string): ProviderOptionDescriptor => ({
  id,
  label: "Effort",
  type: "select",
  options: ["low", "medium", "high", "xhigh", "max"].map((id) => ({
    id,
    label: id,
    isDefault: id === "medium",
  })),
});
const provider = (
  instanceId: string,
  driver: string,
  model: string,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-25T00:00:00Z",
  slashCommands: [],
  skills: [],
  models: [
    { slug: model, name: model, isCustom: false, capabilities: { optionDescriptors: descriptors } },
  ],
});
const providers = [
  {
    ...provider("claudeAgent", "claudeAgent", "claude-opus-5-5", []),
    models: BUNDLED_CLAUDE_MODEL_CATALOG.models.map(({ model }) => model),
  },
  provider("codex", "codex", "gpt-6-astra", [
    effort("reasoningEffort"),
    {
      id: "serviceTier",
      label: "Tier",
      type: "select",
      options: ["default", "priority"].map((id) => ({ id, label: id })),
      currentValue: "default",
    },
  ]),
];
const defaults = [
  {
    label: "architect runners",
    defaultValue: "claude-opus-5-5-xhigh, gpt-6-astra-high-fast",
  },
];
const capableInstanceIds = new Set(providers.map((provider) => provider.instanceId));
const availability = {
  settings: DEFAULT_SERVER_SETTINGS,
  projectId: ProjectId.make("pstack"),
  nowMs: Date.parse("2026-10-25T00:00:00Z"),
};
const file =
  "# budget: balanced\narchitect runners: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6-astra reasoningEffort=high";

it.effect("leaves speed to the provider unless the models file sets it", () =>
  Effect.sync(() => {
    const resolved = resolveRoles({
      ...availability,
      file: parseModelsFile(file),
      defaults,
      providers,
      capableInstanceIds,
    });
    const targets = resolved.roles[0]!.seats.map((seat) => {
      assert.equal(seat.kind, "target");
      return seat.kind === "target" ? seat.target : undefined;
    });
    assert.deepEqual(targets, [
      {
        providerInstanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [
          { id: "effort", value: "xhigh" },
          { id: "ultracode", value: false },
        ],
      },
      {
        providerInstanceId: "codex",
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    ]);
    const explicit = resolveRoles({
      ...availability,
      file: parseModelsFile(
        "architect runners: codex/gpt-6-astra reasoningEffort=high serviceTier=priority",
      ),
      defaults,
      providers,
      capableInstanceIds,
    });
    assert.deepEqual(explicit.roles[0]!.seats[0], {
      kind: "target",
      target: {
        providerInstanceId: "codex",
        model: "gpt-6-astra",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
      },
    });
  }),
);

it.effect.each([
  { label: "arena runners", panel: true },
  { label: "architect runners", panel: true },
  { label: "interrogate reviewers", panel: true },
  { label: "feature, refactoring", panel: false },
  { label: "arena cross-judge pool", panel: false },
  { label: "swarm workers", panel: false },
])("unavailable seats preserve panels but do not pollute pools: $label", ({ label, panel }) =>
  Effect.sync(() => {
    const roleFile = parseModelsFile(file.replace("architect runners:", `${label}:`));
    const roleDefaults = [{ ...defaults[0]!, label }];
    const result = resolveRoles({
      ...availability,
      file: roleFile,
      defaults: roleDefaults,
      providers: providers.map((provider) => ({ ...provider, enabled: false })),
      capableInstanceIds,
    });
    assert.deepEqual(
      result.roles[0]!.seats,
      panel ? [{ kind: "inherit" }, { kind: "inherit" }] : [{ kind: "inherit" }],
    );
    assert.equal(result.diagnostics.length, 2);
    assert.include(
      result.diagnostics[0]!,
      `Fallback: ${label} seat 1 claudeAgent/claude-opus-5-5 unavailable (Provider instance is disabled.)`,
    );
    const partial = resolveRoles({
      ...availability,
      file: roleFile,
      defaults: roleDefaults,
      providers: providers.map((provider, index) => ({ ...provider, enabled: index !== 0 })),
      capableInstanceIds,
    });
    assert.deepEqual(
      partial.roles[0]!.seats.map((seat) => seat.kind),
      panel ? ["inherit", "target"] : ["target"],
    );
    assert.include(partial.diagnostics[0]!, `Fallback: ${label} seat 1`);
    const aliases = resolveRoles({
      ...availability,
      file: parseModelsFile(`${label}: auto, inherit-parent, missing/model`),
      defaults: roleDefaults,
      providers,
      capableInstanceIds,
    });
    assert.deepEqual(
      aliases.roles[0]!.seats,
      Array.from({ length: panel ? 3 : 2 }, () => ({ kind: "inherit" })),
    );
    assert.include(aliases.diagnostics[0]!, `Fallback: ${label} seat 3 missing/model`);
  }),
);
it.effect("missing models file maps upstream family and effort, ignoring -fast", () =>
  Effect.sync(() => {
    const result = resolveRoles({
      ...availability,
      file: undefined,
      defaults,
      providers,
      capableInstanceIds,
    });
    assert.deepEqual(result.diagnostics, []);
    const seat = result.roles[0]!.seats[1]!;
    assert.deepEqual(seat, {
      kind: "target",
      target: {
        providerInstanceId: "codex",
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  }),
);
it.effect.each(["effort=ultra", "unknown=true", "fastMode=yes", "effort=high effort=low"])(
  "invalid option %s falls back",
  (option) =>
    Effect.sync(() => {
      const result = resolveRoles({
        ...availability,
        file: parseModelsFile(`architect runners: claudeAgent/claude-opus-5-5 ${option}`),
        defaults,
        providers,
        capableInstanceIds,
      });
      assert.deepEqual(result.roles[0]!.seats, [{ kind: "inherit" }]);
      assert.equal(result.diagnostics.length, 1);
    }),
);
it.effect("preserves explicit panel cardinality, aliases, comments and model slashes", () =>
  Effect.sync(() => {
    const parsed = parseModelsFile(
      "# budget: high\narchitect runners: auto, inherit-parent, missing/vendor/model option=false # note",
    );
    const result = resolveRoles({
      ...availability,
      file: parsed,
      defaults,
      providers,
      capableInstanceIds,
    });
    assert.equal(result.roles[0]!.seats.length, 3);
    assert.include(result.diagnostics[0]!, "missing/vendor/model");
  }),
);
it.effect.each([
  { instanceId: "custom-codex", driver: "codex", model: "gpt-6-astra" },
  { instanceId: "pi", driver: "pi", model: "openai/gpt-6-astra" },
  { instanceId: "opencode-work", driver: "opencode2", model: "openai/gpt-6-astra" },
  { instanceId: "acp-work", driver: "acpRegistry", model: "gpt-6-astra" },
])(
  "resolves default models and advertised thinking across harnesses: $driver",
  ({ instanceId, driver, model }) =>
    Effect.sync(() => {
      const piStyle = provider(instanceId, driver, model, [effort("thinking")]);
      const result = resolveRoles({
        ...availability,
        file: undefined,
        defaults: [{ label: "runner", defaultValue: "gpt-6-astra-xhigh-fast" }],
        providers: [{ ...providers[1]!, enabled: false }, piStyle],
        capableInstanceIds: new Set([piStyle.instanceId]),
      });
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(result.roles[0]!.seats, [
        {
          kind: "target",
          target: {
            providerInstanceId: instanceId,
            model,
            options: [{ id: "thinking", value: "xhigh" }],
          },
        },
      ]);
    }),
);
it.effect(
  "keeps advertised default model IDs intact and does not require a reasoning control",
  () =>
    Effect.sync(() => {
      const catalog = provider("pi", "pi", "grok-4.7", []);
      const exact = provider("custom", "acpRegistry", "custom-fast", []);
      const result = resolveRoles({
        ...availability,
        file: undefined,
        defaults: [{ label: "architect runners", defaultValue: "grok-4.7-xhigh, custom-fast" }],
        providers: [catalog, exact],
        capableInstanceIds: new Set([catalog.instanceId, exact.instanceId]),
      });
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(result.roles[0]!.seats, [
        { kind: "target", target: { providerInstanceId: "pi", model: "grok-4.7", options: [] } },
        {
          kind: "target",
          target: { providerInstanceId: "custom", model: "custom-fast", options: [] },
        },
      ]);
    }),
);
it.effect(
  "does not guess a provider-qualified model when an unqualified default is ambiguous",
  () =>
    Effect.sync(() => {
      const catalog = provider("pi", "pi", "vendor-a/shared-model", []);
      const other = provider("opencode", "opencode2", "vendor-b/shared-model", []);
      const result = resolveRoles({
        ...availability,
        file: undefined,
        defaults: [{ label: "architect runners", defaultValue: "shared-model" }],
        providers: [catalog, other],
        capableInstanceIds: new Set([catalog.instanceId, other.instanceId]),
      });
      assert.deepEqual(result.roles[0]!.seats, [{ kind: "inherit" }]);
      assert.include(result.diagnostics[0]!, "ambiguous");
    }),
);
it.effect("prefers the parent's available harness and reports unavailable inherited seats", () =>
  Effect.sync(() => {
    const other = provider("pi", "pi", "gpt-6-astra", [effort("thinking")]);
    const input = {
      ...availability,
      defaults: [{ label: "architect runners", defaultValue: "gpt-6-astra-high, inherit-parent" }],
      providers: [...providers, other],
      capableInstanceIds: new Set([...capableInstanceIds, other.instanceId]),
      parentModelSelection: { instanceId: other.instanceId, model: "gpt-6-astra" },
      file: undefined,
    };
    const result = resolveRoles(input);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.roles[0]!.seats, [
      {
        kind: "target",
        target: {
          providerInstanceId: "pi",
          model: "gpt-6-astra",
          options: [{ id: "thinking", value: "high" }],
        },
      },
      { kind: "inherit" },
    ]);
    const unavailable = resolveRoles({
      ...input,
      file: parseModelsFile("architect runners: auto, missing/model"),
      providers: [...providers, { ...other, enabled: false }],
    });
    assert.deepEqual(unavailable.roles[0]!.seats, [
      { kind: "unavailable" },
      { kind: "unavailable" },
    ]);
    assert.include(unavailable.diagnostics.join("\n"), "Parent model cannot run a child task");
    assert.notInclude(unavailable.diagnostics.join("\n"), "runs on the parent model");
  }),
);
it.effect("parses option booleans according to the selected model's descriptors", () =>
  Effect.sync(() => {
    const catalog = provider("pi", "pi", "vendor/model", [
      { id: "enabled", label: "Enabled", type: "boolean" },
      {
        id: "variant",
        label: "Variant",
        type: "select",
        options: [
          { id: "true", label: "True" },
          { id: "false", label: "False" },
        ],
      },
    ]);
    const result = resolveRoles({
      ...availability,
      file: parseModelsFile("architect runners: pi/vendor/model enabled=false variant=true"),
      defaults,
      providers: [catalog],
      capableInstanceIds: new Set([catalog.instanceId]),
    });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.roles[0]!.seats, [
      {
        kind: "target",
        target: {
          providerInstanceId: "pi",
          model: "vendor/model",
          options: [
            { id: "enabled", value: false },
            { id: "variant", value: "true" },
          ],
        },
      },
    ]);
  }),
);
it.effect("unregistered adapters and missing current values cannot leak parent options", () =>
  Effect.sync(() => {
    const unsupported = resolveRoles({
      ...availability,
      file: parseModelsFile(file),
      defaults,
      providers,
      capableInstanceIds: new Set(),
    });
    assert.include(unsupported.diagnostics[0]!, "No V2 provider adapter");
    const incomplete = provider("codex", "codex", "gpt-6-astra", [
      {
        id: "thinking",
        type: "select",
        label: "Thinking",
        options: [{ id: "high", label: "High" }],
      },
    ]);
    const result = resolveRoles({
      ...availability,
      file: parseModelsFile("architect runners: codex/gpt-6-astra"),
      defaults,
      providers: [incomplete],
      capableInstanceIds,
    });
    assert.include(result.diagnostics[0]!, "option thinking has no current value");
  }),
);
it.effect("formats the adapter block exactly and omits empty notes", () =>
  Effect.sync(() => {
    assert.equal(
      formatPstackBlock({
        skillNames: ["architect", "arena"],
        packDir: "/pack",
        modelsPath: "/models.md",
        resolved: {
          roles: [
            { role: "architect runners", seats: [{ kind: "inherit" }] },
            { role: "interrogate reviewers", seats: [{ kind: "inherit" }, { kind: "inherit" }] },
            { role: "feature, refactoring", seats: [{ kind: "inherit" }, { kind: "inherit" }] },
          ],
          diagnostics: [],
        },
      }),
      [
        "<t3_pstack>",
        "pstack skill: architect, arena",
        "<pstack>: /pack",
        "<models>: /models.md",
        "Read <pstack>/skills/architect/SKILL.md and follow it.",
        "Read <pstack>/skills/arena/SKILL.md and follow it.",
        "Resolved roles (exact delegate_task targets; they override any model a skill or <models> names):",
        "These targets are a snapshot. If a target is rejected or marked unavailable, refresh orchestrator_capabilities before retrying; keep the user's model choices and reasoning budget, and report any fallback.",
        "After setup-pstack changes <models>, re-read it and resolve against fresh orchestrator_capabilities; the earlier targets below no longer apply.",
        "- architect runners: [1] inherit",
        "- interrogate reviewers (panel, one child per seat): [1] inherit [2] inherit",
        "- feature, refactoring (pool, pick one per spawn): [1] inherit [2] inherit",
        "</t3_pstack>",
      ].join("\n"),
    );
  }),
);

it.effect.each(["claude-opus-5-5", "claude-sonnet-4-6"])(
  "completes bundled Claude %s descriptors without synthetic current values",
  (model) =>
    Effect.sync(() => {
      const result = resolveRoles({
        ...availability,
        file: parseModelsFile(`architect runners: claudeAgent/${model}`),
        defaults,
        providers,
        capableInstanceIds,
      });
      assert.deepEqual(result.diagnostics, []);
      const seat = result.roles[0]!.seats[0]!;
      assert.equal(seat.kind, "target");
      if (seat.kind === "target") {
        const descriptors = providers[0]!.models.find((entry) => entry.slug === model)!
          .capabilities!.optionDescriptors!;
        assert.deepEqual(
          seat.target.options,
          descriptors
            .filter((descriptor) => descriptor.id !== "fastMode")
            .map((descriptor) => ({
              id: descriptor.id,
              value:
                descriptor.type === "boolean"
                  ? false
                  : descriptor.options.find((option) => option.isDefault)!.id,
            })),
        );
      }
    }),
);
it.effect("completes a Pi thinking select from isDefault", () =>
  Effect.sync(() => {
    const pi = provider("pi", "pi", "vendor/model", [effort("thinking")]);
    const result = resolveRoles({
      ...availability,
      file: parseModelsFile("architect runners: pi/vendor/model"),
      defaults,
      providers: [pi],
      capableInstanceIds: new Set([pi.instanceId]),
    });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.roles[0]!.seats, [
      {
        kind: "target",
        target: {
          providerInstanceId: "pi",
          model: "vendor/model",
          options: [{ id: "thinking", value: "medium" }],
        },
      },
    ]);
  }),
);
it.effect("default seats skip unhealthy and incapable instances offering the model", () =>
  Effect.sync(() => {
    const first = providers[1]!;
    const unhealthy = {
      ...first,
      instanceId: ProviderInstanceId.make("unhealthy"),
      installed: false,
    };
    const incapable = { ...first, instanceId: ProviderInstanceId.make("incapable") };
    const missingDefault = provider("missing-default", "codex", "gpt-6-astra", [
      effort("reasoningEffort"),
      {
        id: "variant",
        label: "Variant",
        type: "select",
        options: [{ id: "standard", label: "Standard" }],
      },
    ]);
    const result = resolveRoles({
      ...availability,
      file: undefined,
      defaults,
      providers: [unhealthy, incapable, missingDefault, ...providers],
      capableInstanceIds: new Set([
        ...capableInstanceIds,
        unhealthy.instanceId,
        missingDefault.instanceId,
      ]),
    });
    assert.deepEqual(result.diagnostics, []);
    const seat = result.roles[0]!.seats[1]!;
    assert.equal(seat.kind === "target" && seat.target.providerInstanceId, "codex");
  }),
);
it.effect.each([false, true])(
  "implicit model defaults follow orchestration visibility; custom=%s",
  (isCustom) =>
    Effect.sync(() => {
      const codex = providers[1]!;
      const input = {
        ...availability,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerModelPreferences: {
            [codex.instanceId]: { hiddenModels: ["gpt-6-astra"], modelOrder: [] },
          },
        },
        defaults: [{ label: "architect runners", defaultValue: "gpt-6-astra-high" }],
        providers: [{ ...codex, models: codex.models.map((model) => ({ ...model, isCustom })) }],
        capableInstanceIds,
      };
      const implicit = resolveRoles({ ...input, file: undefined });
      assert.equal(implicit.roles[0]!.seats[0]!.kind, isCustom ? "target" : "inherit");
      const explicit = resolveRoles({
        ...input,
        file: parseModelsFile("architect runners: codex/gpt-6-astra reasoningEffort=high"),
      });
      assert.equal(explicit.roles[0]!.seats[0]!.kind, "target");
      assert.deepEqual(explicit.diagnostics, []);
    }),
);
it.effect("clamps default effort below its budget", () =>
  Effect.sync(() => {
    const codex = provider("codex", "codex", "gpt-6-astra", [
      {
        id: "reasoningEffort",
        label: "Effort",
        type: "select",
        options: ["low", "high", "ultra"].map((id) => ({
          id,
          label: id,
          isDefault: id === "high",
        })),
      },
      {
        id: "serviceTier",
        label: "Tier",
        type: "select",
        options: [
          { id: "default", label: "Default", isDefault: true },
          { id: "fast", label: "Fast" },
        ],
      },
    ]);
    const result = resolveRoles({
      ...availability,
      file: undefined,
      defaults: [{ label: "architect runners", defaultValue: "gpt-6-astra-xhigh-fast" }],
      providers: [codex],
      capableInstanceIds,
    });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.roles[0]!.seats, [
      {
        kind: "target",
        target: {
          providerInstanceId: "codex",
          model: "gpt-6-astra",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
    ]);
  }),
);
it.effect("reports unknown role labels and ignores empty comma entries", () =>
  Effect.sync(() => {
    const result = resolveRoles({
      ...availability,
      file: parseModelsFile("archtect runners: auto\narchitect runners: auto,, inherit-parent, "),
      defaults,
      providers,
      capableInstanceIds,
    });
    assert.deepEqual(result.roles[0]!.seats, [{ kind: "inherit" }, { kind: "inherit" }]);
    assert.include(result.diagnostics[0]!, "Unknown role archtect runners");
  }),
);

it.effect.each(["", " ,,", " # comment"])(
  "empty role value %s uses defaults with a diagnostic",
  (value) =>
    Effect.sync(() => {
      const result = resolveRoles({
        ...availability,
        file: parseModelsFile(`architect runners:${value}`),
        defaults,
        providers,
        capableInstanceIds,
      });
      const expected = resolveRoles({
        ...availability,
        file: undefined,
        defaults,
        providers,
        capableInstanceIds,
      });
      assert.deepEqual(result.roles, expected.roles);
      assert.include(result.diagnostics.join("\n"), "empty role architect runners; using defaults");
    }),
);
