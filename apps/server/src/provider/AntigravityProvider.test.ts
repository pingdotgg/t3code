import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  AntigravitySettings,
  isProviderWorkspaceSnapshotPending,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { ServerProvider } from "@t3tools/contracts";
import {
  buildAntigravityModelsFromSession,
  makeAntigravityProvider,
} from "./AntigravityProvider.ts";
import { mergeProviderSnapshot } from "./ProviderRegistry.ts";

const decodeSettings = Schema.decodeSync(AntigravitySettings);
const instanceId = ProviderInstanceId.make("antigravity-test");
const driver = ProviderDriverKind.make("antigravity");

const initializeResult = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: true, embeddedContext: true },
    sessionCapabilities: { list: {}, resume: {} },
  },
  authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
  agentInfo: {
    name: "antigravity-acp",
    title: "Google Antigravity",
    version: "1.5.12",
  },
} satisfies EffectAcpSchema.InitializeResponse;

const modelOptions = [
  { value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { value: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { value: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
  { value: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
  { value: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
  { value: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
  { value: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)" },
  { value: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)" },
  { value: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
  { value: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
];

const modelConfig = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "gemini-3.7-flash-high",
  options: modelOptions,
} satisfies EffectAcpSchema.SessionConfigOption;

const sessionSetupResult = {
  sessionId: "session-1",
  models: {
    currentModelId: "gemini-3.7-flash-high",
    availableModels: modelOptions.map((option) => ({ modelId: option.value, name: option.name })),
  },
  configOptions: [
    modelConfig,
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "yolo", name: "YOLO" },
      ],
    },
  ],
} satisfies EffectAcpSchema.NewSessionResponse;

const started = {
  sessionId: "session-1",
  initializeResult,
  sessionSetupResult,
  modelConfigId: "model",
} satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult;

const commands = [
  { name: "plan", description: "Create a plan", input: { type: "text", hint: "What to plan" } },
  { name: "logout", description: "Sign out of Google" },
] satisfies ReadonlyArray<EffectAcpSchema.AvailableCommand>;

const expectedCommands = [
  { name: "plan", description: "Create a plan", input: { hint: "What to plan" } },
  { name: "logout", description: "Sign out of Google" },
];

const makeLayerTest = (runBackgroundWork: boolean) =>
  ProviderHostLive.layer.pipe(
    Layer.provideMerge(
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(runBackgroundWork),
      }),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-antigravity-provider-test-" }).pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  );
const layerTest = makeLayerTest(false);

type ProbeError = EffectAcpErrors.AcpError | ProviderSetupError;

const makeHarness = Effect.fn("makeAntigravityProviderHarness")(function* (
  options: {
    readonly auth?: { readonly type: string; readonly label: string };
    readonly enabled?: boolean;
    readonly safe?: boolean;
    readonly rememberedRuntimeModes?: ReadonlyArray<RuntimeMode>;
  } = {},
) {
  const savedRuntimeModes = yield* Ref.make<ReadonlyArray<ReadonlyArray<RuntimeMode>>>([]);
  const initialProbe = yield* Deferred.make<EffectAcpSchema.InitializeResponse, ProbeError>();
  const probeCalls = yield* Ref.make(0);
  const safetyCalls = yield* Ref.make(0);
  const probe = yield* Ref.make<Effect.Effect<EffectAcpSchema.InitializeResponse, ProbeError>>(
    Deferred.await(initialProbe),
  );
  const safety = yield* Ref.make<Effect.Effect<boolean>>(Effect.succeed(options.safe ?? true));
  const provider = yield* makeAntigravityProvider(
    decodeSettings({ enabled: options.enabled ?? true, customModels: ["do-not-seed-me"] }),
    {
      stampIdentity: (snapshot) => Effect.succeed({ ...snapshot, instanceId, driver }),
      ...(options.auth ? { auth: options.auth } : {}),
      ...(options.rememberedRuntimeModes
        ? { rememberedRuntimeModes: options.rememberedRuntimeModes }
        : {}),
      rememberRuntimeModes: (modes) => Ref.update(savedRuntimeModes, (saved) => [...saved, modes]),
      probe: Ref.update(probeCalls, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(probe)),
        Effect.flatten,
      ),
      supportsTextGeneration: Ref.update(safetyCalls, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(safety)),
        Effect.flatten,
      ),
    },
  );
  const initialUpdate = yield* Stream.toPull(
    provider.snapshot.streamChanges.pipe(
      Stream.filter((snapshot) => snapshot.installed || snapshot.status === "error"),
    ),
  );
  const initialize = Deferred.succeed(initialProbe, initializeResult).pipe(
    Effect.andThen(initialUpdate),
    Effect.asVoid,
  );
  // Subscribe before the trigger; yield the returned pull to await the publish.
  const nextPublish = (predicate: (snapshot: ServerProvider) => boolean) =>
    Stream.toPull(provider.snapshot.streamChanges.pipe(Stream.filter(predicate))).pipe(
      Effect.map((pull) => pull.pipe(Effect.map((snapshots) => snapshots[0]))),
    );
  return {
    provider,
    probe,
    probeCalls,
    safety,
    safetyCalls,
    initialProbe,
    initialUpdate,
    initialize,
    nextPublish,
    savedRuntimeModes,
  };
});

describe("Antigravity model catalog", () => {
  it("uses legacy session models only when model config is absent", () => {
    const fromLegacy = buildAntigravityModelsFromSession({
      models: sessionSetupResult.models,
    });
    expect(fromLegacy).toEqual(buildAntigravityModelsFromSession(sessionSetupResult));
    expect(
      buildAntigravityModelsFromSession({
        ...sessionSetupResult,
        configOptions: [{ ...modelConfig, options: [] }],
      }),
    ).toEqual([]);
  });

  it("flattens native option groups without combining distinct model IDs", () => {
    const models = buildAntigravityModelsFromSession({
      configOptions: [
        {
          ...modelConfig,
          currentValue: "gemini-pro-agent",
          options: [
            { groupId: "Flash", name: "Flash", options: [modelOptions[3]!, modelOptions[4]!] },
            { groupId: "Pro", name: "Pro", options: [modelOptions[9]!, modelOptions[3]!] },
          ],
        },
      ],
    });
    expect(models.map((model) => model.slug)).toEqual([
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-medium",
      "gemini-pro-agent",
    ]);
    expect(models.find((model) => model.isDefault)?.slug).toBe("gemini-pro-agent");
    expect(models.find((model) => model.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL))?.slug).toBe(
      "gemini-pro-agent",
    );
  });

  it("labels models that share a display name with their IDs", () => {
    const models = buildAntigravityModelsFromSession({
      configOptions: [
        {
          ...modelConfig,
          currentValue: "gemini-3.8-flash",
          options: [
            { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
            { value: "gemini-3.8-flash-preview", name: "Gemini 3.8 Flash" },
          ],
        },
      ],
    });
    expect(models.map((model) => model.name)).toEqual([
      "Gemini 3.8 Flash",
      "Gemini 3.8 Flash (gemini-3.8-flash-preview)",
    ]);
  });

  it("offers each model only the thinking levels it reported when selected", () => {
    const thinking = (currentValue: string) =>
      ({
        id: "thinking_level",
        name: "Thinking Level",
        category: "thought_level",
        type: "select",
        currentValue,
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      }) satisfies EffectAcpSchema.SessionConfigOption;
    const models = buildAntigravityModelsFromSession(
      {
        configOptions: [
          {
            ...modelConfig,
            currentValue: "gemini",
            options: [
              { value: "gemini", name: "Gemini" },
              { value: "claude", name: "Claude" },
              { value: "plain", name: "Plain" },
              { value: "unseen", name: "Unseen" },
            ],
          },
          thinking("high"),
        ],
      },
      new Map([
        ["claude", thinking("low")],
        ["plain", null],
      ]),
    );
    const thinkingOf = (slug: string) =>
      models.find((model) => model.slug === slug)?.capabilities?.optionDescriptors?.[0];

    expect(thinkingOf("gemini")).toMatchObject({ id: "thinking_level", currentValue: "high" });
    expect(thinkingOf("claude")).toMatchObject({ id: "thinking_level", currentValue: "low" });
    expect(thinkingOf("plain")).toBeUndefined();
    expect(thinkingOf("unseen")).toBeUndefined();
  });

  it("keeps each model's probed thinking levels after a restart observes only the active model", () => {
    const thinking = (levels: ReadonlyArray<string>) =>
      ({
        id: "thinking_level",
        name: "Thinking Level",
        category: "thought_level",
        type: "select",
        currentValue: "low",
        options: levels.map((value) => ({ value, name: value })),
      }) satisfies EffectAcpSchema.SessionConfigOption;
    const deep = thinking(["low", "medium", "high", "xhigh"]);
    const models = {
      ...modelConfig,
      currentValue: "neon",
      options: [
        { value: "neon", name: "Neon" },
        { value: "carbon", name: "Carbon" },
        { value: "fixed", name: "Fixed effort" },
      ],
    } satisfies EffectAcpSchema.SessionConfigOption;
    const setup = { configOptions: [models, deep] };
    const provider = {
      instanceId,
      driver,
      status: "ready",
      enabled: true,
      installed: true,
      version: null,
      auth: { status: "authenticated" },
      checkedAt: "2026-11-23T00:00:00.000Z",
      slashCommands: [],
      skills: [],
    } as const;
    // Sign-in or Refresh models walks every model, so each reports its own levels.
    const probed = {
      ...provider,
      models: buildAntigravityModelsFromSession(
        setup,
        new Map([
          ["carbon", thinking(["low", "medium", "high"])],
          ["fixed", null],
        ]),
      ),
    } satisfies ServerProvider;
    // After a restart the provider has observed only the session's model.
    const restarted = {
      ...provider,
      checkedAt: "2026-11-23T01:00:00.000Z",
      models: buildAntigravityModelsFromSession(setup, new Map([["neon", deep]])),
    } satisfies ServerProvider;

    const merged = mergeProviderSnapshot(probed, restarted);
    const levelsOf = (slug: string) => {
      const descriptor = merged.models.find((model) => model.slug === slug)?.capabilities
        ?.optionDescriptors?.[0];
      return descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [];
    };

    expect(levelsOf("neon")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(levelsOf("carbon")).toEqual(["low", "medium", "high"]);
    expect(levelsOf("fixed")).toEqual([]);
  });
});

it.layer(layerTest)("Antigravity provider snapshots", (it) => {
  it.effect("does not probe or run helper safety checks while disabled", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: false });
      const snapshot = yield* harness.provider.snapshot.refresh;
      expect(snapshot).toMatchObject({
        enabled: false,
        installed: false,
        status: "disabled",
        auth: { status: "unknown" },
        models: [],
        setup: { canAuthenticate: true, canInstall: true },
        showInteractionModeToggle: false,
        supportsConversationRollback: true,
        supportsTextGeneration: false,
      });
      expect(yield* Ref.get(harness.probeCalls)).toBe(0);
      expect(yield* Ref.get(harness.safetyCalls)).toBe(0);
    }),
  );

  it.effect("treats initialize as installation proof, not account or model discovery", () =>
    Effect.gen(function* () {
      for (const auth of [
        undefined,
        { type: "oauth-personal", label: "Google account" },
        { type: "oauth-business", label: "Gemini Enterprise" },
        { type: "gemini-api-key", label: "Gemini API key" },
        { type: "agent-platform", label: "Agent Platform" },
      ]) {
        const harness = yield* makeHarness(auth ? { auth } : {});
        expect(yield* harness.provider.snapshot.getSnapshot).toMatchObject({
          installed: false,
          status: "warning",
          auth: { status: "unknown" },
          models: [],
        });
        yield* harness.initialize;
        const snapshot = yield* harness.provider.snapshot.getSnapshot;
        expect(snapshot).toMatchObject({
          installed: true,
          status: "warning",
          version: "1.5.12",
          auth: { status: "unknown", ...(auth ? { type: auth.type } : {}) },
          message:
            auth?.type === "gemini-api-key" || auth?.type === "agent-platform"
              ? `Antigravity is installed. Connect with ${auth.label} to load models.`
              : "Antigravity is installed. Google account access is not checked yet.",
          models: [],
        });
        expect(yield* Ref.get(harness.probeCalls)).toBe(1);
      }
    }),
  );

  it.effect("offers Auto only while the signed-in session advertises agy's own Auto", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.initialize;
      const supportedModes = harness.provider.snapshot.getSnapshot.pipe(
        Effect.map((snapshot) => snapshot.supportedRuntimeModes),
      );
      const withoutAuto = ["approval-required", "auto-accept-edits", "full-access"];
      const startedWithAuto = {
        ...started,
        sessionSetupResult: {
          ...sessionSetupResult,
          modes: {
            currentModeId: "default",
            availableModes: [
              { id: "default", name: "Default" },
              { id: "auto", name: "Auto" },
            ],
          },
        },
      };
      expect(yield* supportedModes).toEqual(withoutAuto);
      yield* harness.provider.onSessionStarted(startedWithAuto);
      expect(yield* supportedModes).toEqual([
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]);
      yield* harness.provider.onSessionStarted(started);
      expect(yield* supportedModes).toEqual(withoutAuto);
      yield* harness.provider.onSessionStarted(startedWithAuto);
      yield* harness.provider.onSignedOut;
      expect(yield* supportedModes).toEqual(withoutAuto);
      const withAuto: ReadonlyArray<RuntimeMode> = [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ];
      expect(yield* Ref.get(harness.savedRuntimeModes)).toEqual([
        withAuto,
        withoutAuto,
        withAuto,
        withoutAuto,
      ]);

      // A restart offers what the last session advertised before any session starts.
      const restarted = yield* makeHarness({ rememberedRuntimeModes: withAuto });
      yield* restarted.initialize;
      expect(yield* restarted.provider.snapshot.getSnapshot).toMatchObject({
        supportedRuntimeModes: withAuto,
      });
    }),
  );

  it.effect("publishes session metadata and native commands without another health probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.initialize;
      const nextReady = yield* Stream.toPull(
        harness.provider.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.auth.status === "authenticated" && snapshot.slashCommands.length > 0,
          ),
        ),
      );
      yield* harness.provider.onSessionStarted(started, "/workspace");
      yield* harness.provider.onAvailableCommands(commands, "/workspace");
      const [snapshot] = yield* nextReady;
      expect(snapshot).toMatchObject({
        status: "ready",
        auth: { status: "authenticated", type: "oauth-personal" },
        supportsTextGeneration: true,
      });
      expect(snapshot.models).toEqual(buildAntigravityModelsFromSession(sessionSetupResult));
      expect(snapshot.slashCommands).toEqual(expectedCommands);
      expect((yield* harness.provider.snapshotForCwd("/workspace")).slashCommands).toEqual(
        expectedCommands,
      );
      expect(yield* Ref.get(harness.probeCalls)).toBe(1);
    }),
  );

  it.effect("keeps a workspace's native commands when the catalog reports its own", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.initialize;
      yield* harness.provider.onSessionStarted(started, "/workspace");
      yield* harness.provider.onAvailableCommands(commands, "/workspace");
      // The catalog probe runs in a scratch directory and reports no cwd.
      yield* harness.provider.onAvailableCommands(commands.slice(1));
      expect((yield* harness.provider.snapshotForCwd("/workspace")).slashCommands).toEqual(
        expectedCommands,
      );
      expect((yield* harness.provider.snapshot.getSnapshot).slashCommands).toEqual(
        expectedCommands.slice(1),
      );
    }),
  );

  it.effect("clears all account metadata on sign-out and authentication failure", () =>
    Effect.gen(function* () {
      const auth = { type: "gemini-api-key", label: "Gemini API key" };
      const harness = yield* makeHarness({ auth });
      yield* harness.initialize;
      for (const clear of [harness.provider.onSignedOut, harness.provider.onAuthRequired]) {
        yield* harness.provider.onSessionStarted(started, "/workspace");
        yield* harness.provider.onAvailableCommands(commands, "/workspace");
        yield* clear;
        expect(yield* harness.provider.snapshot.getSnapshot).toMatchObject({
          installed: true,
          status: "warning",
          auth: { status: "unauthenticated", type: auth.type, label: auth.label },
          message: "Connect with Gemini API key to use Antigravity and load models.",
          models: [],
          slashCommands: [],
          skills: [],
          workspaceSnapshots: [],
          supportsTextGeneration: false,
        });
        yield* harness.provider.onAvailableCommands(commands, "/workspace");
        yield* harness.provider.onConfigOptionsUpdated([modelConfig]);
        expect((yield* harness.provider.snapshotForCwd("/workspace")).slashCommands).toEqual([]);
        expect((yield* harness.provider.snapshot.getSnapshot).models).toEqual([]);
      }
      const refreshed = yield* harness.provider.snapshot.refresh;
      expect(refreshed.auth).toEqual({
        status: "unauthenticated",
        type: auth.type,
        label: auth.label,
      });
      expect(refreshed.message).toBe(
        "Connect with Gemini API key to use Antigravity and load models.",
      );
      expect(refreshed.supportsTextGeneration).toBe(false);
    }),
  );

  it.effect("replaces live model choices and accepts an empty catalog", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.initialize;
      yield* harness.provider.onSessionStarted(started, "/workspace");
      yield* harness.provider.onAvailableCommands(commands, "/workspace");
      const before = yield* harness.provider.snapshot.getSnapshot;
      const configOptions = [
        {
          ...modelConfig,
          currentValue: "gemini-3.8-flash-high",
          options: modelOptions.slice(0, 3),
        },
      ];
      const nextSnapshot = yield* Stream.toPull(
        harness.provider.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.models.length === 3),
        ),
      );
      yield* harness.provider.onConfigOptionsUpdated(configOptions);
      expect((yield* nextSnapshot)[0]).toMatchObject({
        models: buildAntigravityModelsFromSession({ configOptions }),
        auth: before.auth,
        workspaceSnapshots: before.workspaceSnapshots,
        slashCommands: expectedCommands,
      });
      yield* harness.provider.onConfigOptionsUpdated([]);
      expect((yield* harness.provider.snapshot.getSnapshot).models).toEqual([]);
    }),
  );

  it.effect(
    "does not let live session thinking-level or model changes overwrite catalog defaults",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        const thinking = (
          currentValue: string,
          levels: ReadonlyArray<string> = ["low", "medium", "high", "xhigh"],
        ) =>
          ({
            id: "thought_level",
            name: "Thinking Level",
            category: "thought_level",
            type: "select",
            currentValue,
            options: levels.map((value) => ({ value, name: value })),
          }) satisfies EffectAcpSchema.SessionConfigOption;
        const catalogModels = {
          ...modelConfig,
          currentValue: "neon",
          options: [
            { value: "neon", name: "Neon" },
            { value: "carbon", name: "Carbon" },
          ],
        } satisfies EffectAcpSchema.SessionConfigOption;
        yield* harness.provider.onSessionStarted(
          {
            ...started,
            sessionSetupResult: {
              sessionId: "session-fresh",
              configOptions: [catalogModels, thinking("high")],
            },
          },
          "/workspace",
        );

        // A live chat session setting thought_level=xhigh must not pollute the catalog default.
        yield* harness.provider.onConfigOptionsUpdated([catalogModels, thinking("xhigh")]);
        // A live chat session switching to another model with a custom level must neither move
        // isDefault nor overwrite cached thinking defaults for that model.
        const switchedToCarbon = {
          ...catalogModels,
          currentValue: "carbon",
        } satisfies EffectAcpSchema.SessionConfigOption;
        yield* harness.provider.onConfigOptionsUpdated([
          switchedToCarbon,
          thinking("low", ["low", "medium", "high"]),
        ]);

        const snapshot = yield* harness.provider.snapshot.getSnapshot;
        const neon = snapshot.models.find((model) => model.slug === "neon");
        const carbon = snapshot.models.find((model) => model.slug === "carbon");
        expect(neon?.isDefault).toBe(true);
        expect(neon?.aliases).toContain(ANTIGRAVITY_DEFAULT_MODEL);
        expect(neon?.capabilities?.optionDescriptors?.[0]).toMatchObject({
          id: "thought_level",
          currentValue: "high",
        });
        expect(carbon?.isDefault).toBeUndefined();
        expect(carbon?.capabilities?.optionDescriptors).toEqual([]);

        // Updating an observed model's choices keeps its recorded default while still offered,
        // and falls back if the agent removes that default.
        yield* harness.provider.onConfigOptionsUpdated([
          catalogModels,
          thinking("max", ["low", "medium", "high", "xhigh", "max"]),
        ]);
        const expanded = (yield* harness.provider.snapshot.getSnapshot).models.find(
          (model) => model.slug === "neon",
        )?.capabilities?.optionDescriptors?.[0];
        expect(expanded).toMatchObject({
          id: "thought_level",
          currentValue: "high",
          options: [
            { id: "low" },
            { id: "medium" },
            { id: "high" },
            { id: "xhigh" },
            { id: "max" },
          ],
        });

        yield* harness.provider.onConfigOptionsUpdated([
          catalogModels,
          thinking("medium", ["low", "medium"]),
        ]);
        const narrowed = (yield* harness.provider.snapshot.getSnapshot).models.find(
          (model) => model.slug === "neon",
        )?.capabilities?.optionDescriptors?.[0];
        expect(narrowed).toMatchObject({
          id: "thought_level",
          currentValue: "medium",
          options: [{ id: "low" }, { id: "medium" }],
        });

        // A catalog probe records each model's default level and keeps the default model intact.
        yield* harness.provider.onConfigOptionsUpdated(
          [switchedToCarbon, thinking("medium", ["low", "medium", "high"])],
          { fromCatalogProbe: true },
        );
        const probed = yield* harness.provider.snapshot.getSnapshot;
        expect(probed.models.find((model) => model.slug === "neon")?.isDefault).toBe(true);
        expect(
          probed.models.find((model) => model.slug === "carbon")?.capabilities
            ?.optionDescriptors?.[0],
        ).toMatchObject({ id: "thought_level", currentValue: "medium" });

        // After a restart, resuming a session on another model at xhigh leaves unobserved
        // models and default identity unset so the registry retains the cached defaults.
        const restarted = yield* makeHarness();
        yield* restarted.initialize;
        yield* restarted.provider.onSessionStarted(
          {
            ...started,
            sessionSetupResult: {
              sessionId: "session-resumed",
              configOptions: [switchedToCarbon, thinking("xhigh")],
            },
          },
          "/workspace",
          { resumed: true },
        );
        const merged = mergeProviderSnapshot(
          probed,
          yield* restarted.provider.snapshot.getSnapshot,
        );
        const mergedNeon = merged.models.find((model) => model.slug === "neon");
        const mergedCarbon = merged.models.find((model) => model.slug === "carbon");
        expect(mergedNeon?.isDefault).toBe(true);
        expect(mergedNeon?.aliases).toContain(ANTIGRAVITY_DEFAULT_MODEL);
        expect(mergedNeon?.capabilities?.optionDescriptors?.[0]).toMatchObject({
          id: "thought_level",
          currentValue: "medium",
        });
        expect(mergedCarbon?.isDefault).toBeUndefined();
        expect(mergedCarbon?.aliases).toBeUndefined();
        expect(mergedCarbon?.capabilities?.optionDescriptors?.[0]).toMatchObject({
          id: "thought_level",
          currentValue: "medium",
        });

        // A later authoritative session start replaces the cached default model.
        yield* restarted.provider.onSessionStarted(
          {
            ...started,
            sessionSetupResult: {
              sessionId: "session-fresh-after-restart",
              configOptions: [switchedToCarbon, thinking("low", ["low", "medium", "high"])],
            },
          },
          "/workspace",
        );
        const updatedAfterFresh = mergeProviderSnapshot(
          merged,
          yield* restarted.provider.snapshot.getSnapshot,
        );
        expect(updatedAfterFresh.models.find((model) => model.slug === "neon")?.isDefault).toBe(
          undefined,
        );
        expect(updatedAfterFresh.models.find((model) => model.slug === "carbon")?.isDefault).toBe(
          true,
        );
        expect(
          updatedAfterFresh.models.find((model) => model.slug === "carbon")?.aliases,
        ).toContain(ANTIGRAVITY_DEFAULT_MODEL);
      }),
  );

  it.effect("does not guess a version before a custom launcher's first handshake", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Deferred.succeed(harness.initialProbe, {
        ...initializeResult,
        agentInfo: { ...initializeResult.agentInfo, version: "unknown" },
      });
      yield* harness.initialUpdate;
      expect((yield* harness.provider.snapshot.getSnapshot).version).toBeNull();
    }),
  );

  it.effect("does not replace a handshake version with an unknown custom-launcher probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.initialize;
      yield* harness.provider.onSessionStarted({
        ...started,
        initializeResult: {
          ...initializeResult,
          agentInfo: { ...initializeResult.agentInfo, version: "1.5.13" },
        },
      });
      yield* Ref.set(
        harness.probe,
        Effect.succeed({
          ...initializeResult,
          agentInfo: { ...initializeResult.agentInfo, version: "unknown" },
        }),
      );
      expect((yield* harness.provider.snapshot.refresh).version).toBe("1.5.13");
    }),
  );

  it.effect("replaces one account's catalog instead of combining accounts", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.initialize;
      yield* harness.provider.onSessionStarted(started);
      yield* harness.provider.onSignedOut;
      yield* harness.provider.onSessionStarted({
        ...started,
        sessionSetupResult: {
          sessionId: "new-account-session",
          configOptions: [
            { ...modelConfig, currentValue: "gemini-pro-agent", options: [modelOptions[9]!] },
          ],
        },
      });
      expect(
        (yield* harness.provider.snapshot.getSnapshot).models.map((model) => model.slug),
      ).toEqual(["gemini-pro-agent"]);
    }),
  );

  it.effect("retains known account metadata when a local health check fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.initialize;
      yield* harness.provider.onSessionStarted(started, "/workspace");
      yield* harness.provider.onAvailableCommands(commands, "/workspace");
      yield* Ref.set(
        harness.probe,
        Effect.fail(EffectAcpErrors.AcpRequestError.internalError("probe failed")),
      );
      const snapshot = yield* harness.provider.snapshot.refresh;
      expect(snapshot).toMatchObject({
        installed: true,
        status: "error",
        auth: { status: "authenticated" },
      });
      expect(snapshot.models).toEqual(buildAntigravityModelsFromSession(sessionSetupResult));
      expect(snapshot.slashCommands).toEqual(expectedCommands);
      expect(snapshot.workspaceSnapshots?.[0]?.cwd).toBe("/workspace");
    }),
  );

  it.effect("distinguishes missing executables from a failed installed executable", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.initialize;
      const failures = [
        {
          error: new EffectAcpErrors.AcpSpawnError({ cause: { code: "ENOENT" } }),
          installed: false,
        },
        {
          error: new EffectAcpErrors.AcpSpawnError({ cause: { code: "EACCES" } }),
          installed: true,
        },
        {
          error: new ProviderSetupError({
            instanceId,
            operation: "resolve",
            detail: "Antigravity is not installed.",
          }),
          installed: false,
        },
        {
          error: new ProviderSetupError({
            instanceId,
            operation: "resolve",
            detail:
              "The managed Antigravity runtime changed on disk. Reinstall it in Antigravity setup.",
          }),
          installed: false,
        },
      ];
      for (const { error, installed } of failures) {
        yield* harness.provider.onSessionStarted(started, "/workspace");
        yield* harness.provider.onAvailableCommands(commands, "/workspace");
        yield* Ref.set(harness.probe, Effect.fail(error));
        const snapshot = yield* harness.provider.snapshot.refresh;
        expect(snapshot).toMatchObject({
          installed,
          status: "error",
          auth: { status: "authenticated" },
        });
        expect(snapshot.models).toHaveLength(installed ? 11 : 0);
        expect(snapshot.slashCommands).toHaveLength(installed ? 2 : 0);
        expect(snapshot.workspaceSnapshots).toHaveLength(installed ? 1 : 0);
        expect(snapshot.supportsTextGeneration).toBe(installed);
      }
    }),
  );

  it.effect("does not let an old health result restore a signed-out account", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.initialize;
      yield* harness.provider.onSessionStarted(started);
      const releaseProbe = yield* Deferred.make<EffectAcpSchema.InitializeResponse>();
      const probeEntered = yield* Deferred.make<void>();
      yield* Ref.set(
        harness.probe,
        Deferred.succeed(probeEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseProbe)),
        ),
      );
      const refresh = yield* harness.provider.snapshot.refresh.pipe(Effect.forkChild);
      yield* Deferred.await(probeEntered);
      yield* harness.provider.onSignedOut;
      yield* Deferred.succeed(releaseProbe, initializeResult);
      const snapshot = yield* Fiber.join(refresh);
      expect(snapshot).toMatchObject({
        auth: { status: "unauthenticated" },
        models: [],
        supportsTextGeneration: false,
      });
    }),
  );

  it.effect("exposes helper support only when the supplied safety check allows it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ safe: false });
      yield* harness.initialize;
      yield* harness.provider.onSessionStarted(started);
      expect((yield* harness.provider.snapshot.getSnapshot).supportsTextGeneration).toBe(false);
      yield* Ref.set(harness.safety, Effect.succeed(true));
      yield* harness.provider.snapshot.refresh;
      expect((yield* harness.provider.snapshot.getSnapshot).supportsTextGeneration).toBe(true);
    }),
  );

  it.effect("keeps discovered workspace skills through session and command updates", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.initialize;
      const skills = [
        {
          name: "deploy",
          description: "Ship it",
          path: "/workspace/.agent/skills/deploy",
          enabled: true,
        },
      ];
      const discovered = yield* harness.provider.snapshotForCwd("/workspace", skills);
      expect(discovered.skills).toEqual(skills);
      yield* harness.provider.onSessionStarted(started, "/workspace");
      yield* harness.provider.onAvailableCommands(commands, "/workspace");
      const after = yield* harness.provider.snapshot.getSnapshot;
      expect(after.workspaceSnapshots?.find((entry) => entry.cwd === "/workspace")?.skills).toEqual(
        skills,
      );
      expect((yield* harness.provider.snapshotForCwd("/workspace")).skills).toEqual(skills);

      const rescanned = [
        ...skills,
        { name: "review", path: "/workspace/.agent/skills/review", enabled: true },
      ];
      yield* harness.provider.snapshotForCwd("/workspace", rescanned);
      yield* harness.provider.onSessionStarted(started, "/workspace");
      expect(
        (yield* harness.provider.snapshot.getSnapshot).workspaceSnapshots?.find(
          (entry) => entry.cwd === "/workspace",
        )?.skills,
      ).toEqual(rescanned);
    }),
  );

  it.effect("a session in an unscanned folder does not publish its skills as scanned", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.initialize;
      const unscanned = () =>
        Effect.map(harness.provider.snapshot.getSnapshot, (snapshot) => {
          const entry = snapshot.workspaceSnapshots?.find((item) => item.cwd === "/workspace");
          // ProviderRegistry skips the skill scan for a current entry that is not pending.
          return entry === undefined || isProviderWorkspaceSnapshotPending(entry);
        });

      yield* harness.provider.onSessionStarted(started, "/workspace");
      expect(yield* unscanned()).toBe(true);
      yield* harness.provider.onAvailableCommands(commands, "/workspace");
      expect(yield* unscanned()).toBe(true);
    }),
  );

  it.effect("a skill scan leaves the folder entry it scanned from unchanged", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.initialize;
      yield* harness.provider.onSessionStarted(started, "/workspace");
      const published = yield* harness.provider.snapshot.getSnapshot;
      const entryOf = (provider: ServerProvider) =>
        provider.workspaceSnapshots?.find((entry) => entry.cwd === "/workspace");
      const skills = [{ name: "deploy", path: "/workspace/.agent/skills/deploy", enabled: true }];

      yield* harness.provider.snapshotForCwd("/workspace", skills);
      // ProviderRegistry saves the scan only if the entry it scanned from is still published.
      const republished = mergeProviderSnapshot(
        published,
        yield* harness.provider.snapshot.getSnapshot,
      );
      expect(entryOf(republished)).toEqual(entryOf(published));
    }),
  );

  it.effect(
    "keeps a scanned folder's own commands when another folder reports different ones",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        yield* harness.provider.onAvailableCommands(commands, "/a");
        yield* harness.provider.snapshotForCwd("/a", []);
        yield* harness.provider.onAvailableCommands(commands.slice(1), "/b");
        expect((yield* harness.provider.snapshotForCwd("/a", [])).slashCommands).toEqual(
          expectedCommands,
        );
        yield* harness.provider.onSessionStarted(started, "/a");
        expect(
          (yield* harness.provider.snapshot.getSnapshot).workspaceSnapshots?.find(
            (entry) => entry.cwd === "/a",
          )?.slashCommands,
        ).toEqual(expectedCommands);
      }),
  );

  it.effect("bounds workspace metadata without starting sessions for workspace lookup", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.initialize;
      yield* harness.provider.onSessionStarted(started);
      for (let index = 0; index < 35; index++) {
        yield* harness.provider.onAvailableCommands(commands, `/workspace-${index}`);
      }
      const snapshot = yield* harness.provider.snapshotForCwd("/workspace-34");
      expect(snapshot.workspaceSnapshots).toHaveLength(32);
      expect(snapshot.workspaceSnapshots?.[0]?.cwd).toBe("/workspace-3");
      expect(snapshot.slashCommands).toEqual(expectedCommands);
      expect(yield* Ref.get(harness.probeCalls)).toBe(1);
    }),
  );
});

it.layer(makeLayerTest(true))("Antigravity periodic health checks", (it) => {
  it.effect("rechecks a ready provider after one failed periodic check before publishing it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.initialize;
      yield* harness.provider.onSessionStarted(started, "/workspace");
      expect((yield* harness.provider.snapshot.getSnapshot).status).toBe("ready");
      const published = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
      yield* harness.provider.snapshot.streamChanges.pipe(
        Stream.runForEach((snapshot) => Ref.update(published, (all) => [...all, snapshot])),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Ref.set(
        harness.probe,
        Effect.fail(EffectAcpErrors.AcpRequestError.internalError("probe failed")),
      );

      yield* TestClock.adjust("5 minutes");

      expect((yield* harness.provider.snapshot.getSnapshot).status).toBe("ready");
      expect((yield* Ref.get(published)).map((snapshot) => snapshot.status)).not.toContain("error");

      yield* Ref.set(harness.probe, Effect.succeed(initializeResult));
      yield* TestClock.adjust("30 seconds");
      const failProbe = yield* Deferred.make<void>();
      yield* Ref.set(
        harness.probe,
        Deferred.await(failProbe).pipe(
          Effect.andThen(
            Effect.fail(EffectAcpErrors.AcpRequestError.internalError("probe failed")),
          ),
        ),
      );
      yield* TestClock.adjust("5 minutes");
      yield* harness.provider.onSignedOut;
      yield* Deferred.succeed(failProbe, undefined);
      yield* TestClock.adjust("30 seconds");

      const auth = (yield* Ref.get(published)).map((snapshot) => snapshot.auth.status);
      expect(auth.slice(auth.indexOf("unauthenticated"))).not.toContain("authenticated");
      expect(auth.at(-1)).toBe("unauthenticated");
    }),
  );
});
