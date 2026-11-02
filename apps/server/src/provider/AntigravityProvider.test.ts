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
      Layer.provideMerge(NodeServices.layer),
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
  return {
    provider,
    probe,
    probeCalls,
    safety,
    safetyCalls,
    initialProbe,
    initialUpdate,
    initialize,
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

it.layer(layerTest)("Antigravity provider snapshots", (it) => {
  it.effect("does not probe or run helper safety checks while disabled", () =>
    Effect.scoped(
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
          supportsConversationRollback: false,
          supportsTextGeneration: false,
        });
        expect(yield* Ref.get(harness.probeCalls)).toBe(0);
        expect(yield* Ref.get(harness.safetyCalls)).toBe(0);
      }),
    ),
  );

  it.effect("treats initialize as installation proof, not account or model discovery", () =>
    Effect.scoped(
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
            version: "agy_acp_server_20260818_01_RC01",
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
    ),
  );

  it.effect("publishes session metadata and native commands without another health probe", () =>
    Effect.scoped(
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
    ),
  );

  it.effect("clears all account metadata on sign-out and authentication failure", () =>
    Effect.scoped(
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
    ),
  );

  it.effect("replaces live model choices and accepts an empty catalog", () =>
    Effect.scoped(
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
    ),
  );

  it.effect("does not guess a version before a custom launcher's first handshake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Deferred.succeed(harness.initialProbe, {
          ...initializeResult,
          agentInfo: { ...initializeResult.agentInfo, version: "unknown" },
        });
        yield* harness.initialUpdate;
        expect((yield* harness.provider.snapshot.getSnapshot).version).toBeNull();
      }),
    ),
  );

  it.effect("does not replace a handshake version with an unknown custom-launcher probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        yield* harness.provider.onSessionStarted({
          ...started,
          initializeResult: {
            ...initializeResult,
            agentInfo: { ...initializeResult.agentInfo, version: "1.4.0" },
          },
        });
        yield* Ref.set(
          harness.probe,
          Effect.succeed({
            ...initializeResult,
            agentInfo: { ...initializeResult.agentInfo, version: "unknown" },
          }),
        );
        expect((yield* harness.provider.snapshot.refresh).version).toBe("1.4.0");
      }),
    ),
  );

  it.effect("replaces one account's catalog instead of combining accounts", () =>
    Effect.scoped(
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
    ),
  );

  it.effect("retains known account metadata when a local health check fails", () =>
    Effect.scoped(
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
    ),
  );

  it.effect("distinguishes missing executables from a failed installed executable", () =>
    Effect.scoped(
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
    ),
  );

  it.effect("does not let an old health result restore a signed-out account", () =>
    Effect.scoped(
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
    ),
  );

  it.effect("exposes helper support only when the supplied safety check allows it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ safe: false });
        yield* harness.initialize;
        yield* harness.provider.onSessionStarted(started);
        expect((yield* harness.provider.snapshot.getSnapshot).supportsTextGeneration).toBe(false);
        yield* Ref.set(harness.safety, Effect.succeed(true));
        yield* harness.provider.snapshot.refresh;
        expect((yield* harness.provider.snapshot.getSnapshot).supportsTextGeneration).toBe(true);
      }),
    ),
  );

  it.effect("keeps discovered workspace skills through session and command updates", () =>
    Effect.scoped(
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
        expect(
          after.workspaceSnapshots?.find((entry) => entry.cwd === "/workspace")?.skills,
        ).toEqual(skills);
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
    ),
  );

  it.effect("bounds workspace metadata without starting sessions for workspace lookup", () =>
    Effect.scoped(
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
    ),
  );

  it.effect(
    "publishes limits, retains a successful read on failure, and clears them on sign-out",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const limits: ServerProviderUsageLimits = {
            checkedAt: "2026-10-09T12:00:00.000Z",
            windows: [
              {
                id: "3p-weekly",
                kind: "weekly",
                label: "Claude & GPT (shared) · Weekly",
                usedPercent: 75,
              },
            ],
          };
          const usage = yield* Ref.make(limits);
          const harness = yield* makeHarness({ probeUsage: Ref.get(usage) });
          yield* harness.initialize;
          expect((yield* harness.provider.snapshot.getSnapshot).usageLimits).toEqual(limits);
          yield* Ref.set(harness.probe, Effect.succeed(initializeResult));
          yield* Ref.set(usage, {
            checkedAt: "2026-10-09T12:01:00.000Z",
            windows: [],
            unavailable: { reason: "probeFailed" },
          });
          expect((yield* harness.provider.snapshot.refresh).usageLimits).toEqual(limits);
          yield* harness.provider.onSignedOut;
          expect((yield* harness.provider.snapshot.getSnapshot).usageLimits).toBeUndefined();
          yield* Ref.set(usage, {
            checkedAt: "2026-10-09T12:02:00.000Z",
            windows: [],
            unavailable: { reason: "unsupported" },
          });
          expect((yield* harness.provider.snapshot.refresh).usageLimits?.windows).toEqual([]);
        }),
      ),
  );

  it.effect("a quota read finishing after sign-out cannot restore account limits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const readStarted = yield* Deferred.make<void>();
        const readResult = yield* Deferred.make<ServerProviderUsageLimits>();
        const usage = yield* Ref.make<Effect.Effect<ServerProviderUsageLimits>>(
          Effect.succeed({ checkedAt: "2026-10-09T12:00:00.000Z", windows: [] }),
        );
        const harness = yield* makeHarness({ probeUsage: Ref.get(usage).pipe(Effect.flatten) });
        yield* harness.initialize;
        yield* Ref.set(harness.probe, Effect.succeed(initializeResult));
        yield* Ref.set(
          usage,
          Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(Deferred.await(readResult))),
        );
        const refresh = yield* harness.provider.snapshot.refresh.pipe(Effect.forkChild);
        yield* Deferred.await(readStarted);
        yield* harness.provider.onSignedOut;
        yield* Deferred.succeed(readResult, {
          checkedAt: "2026-10-09T12:01:00.000Z",
          windows: [
            { id: "gemini-5h", kind: "session", label: "Gemini · 5-hour", usedPercent: 10 },
          ],
        });
        yield* Fiber.join(refresh);
        expect((yield* harness.provider.snapshot.getSnapshot).usageLimits).toBeUndefined();
      }),
    ),
  );
});
