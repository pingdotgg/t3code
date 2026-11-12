import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  AntigravitySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
    version: "agy_acp_server_20260818_01_RC01",
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

const layerTest = ProviderHostLive.layer.pipe(
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
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

type ProbeError = EffectAcpErrors.AcpError | ProviderSetupError;

const makeHarness = Effect.fn("makeAntigravityProviderHarness")(function* (
  options: {
    readonly auth?: { readonly type: string; readonly label: string };
    readonly enabled?: boolean;
    readonly safe?: boolean;
    readonly probeUsage?: Effect.Effect<ServerProviderUsageLimits>;
  } = {},
) {
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
      ...(options.probeUsage ? { probeUsage: options.probeUsage } : {}),
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

  it("offers each model the thinking levels it reported when selected", () => {
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
    expect(thinkingOf("unseen")).toMatchObject({ id: "thinking_level" });
    expect(thinkingOf("unseen")).not.toHaveProperty("currentValue");
  });
});

