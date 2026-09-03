import { describe, expect, it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  AntigravitySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
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
import type * as EffectAcpSchema from "effect-acp/schema";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
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
} satisfies AcpSessionRuntimeStartResult;

const commands = [
  { name: "plan", description: "Create a plan", input: { hint: "What to plan" } },
  { name: "logout", description: "Sign out of Google" },
] satisfies ReadonlyArray<EffectAcpSchema.AvailableCommand>;

const testLayer = Layer.merge(
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(false),
  }),
  ServerSettingsService.layerTest(),
);

type ProbeError = EffectAcpErrors.AcpError | ProviderSetupError;

const makeHarness = Effect.fn("makeAntigravityProviderHarness")(function* (
  options: { readonly enabled?: boolean; readonly safe?: boolean } = {},
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
  it("keeps the captured personal catalog's IDs, labels, order, and selected default", () => {
    const models = buildAntigravityModelsFromSession(sessionSetupResult);
    expect(models.map((model) => [model.slug, model.name])).toEqual(
      modelOptions.map((option) => [option.value, option.name]),
    );
    expect(models.filter((model) => model.isDefault).map((model) => model.slug)).toEqual([
      "gemini-3.7-flash-high",
    ]);
    expect(
      models
        .filter((model) => model.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL))
        .map((model) => model.slug),
    ).toEqual(["gemini-3.7-flash-high"]);
    expect(models.every((model) => model.capabilities?.optionDescriptors?.length === 0)).toBe(true);
    expect(models.every((model) => !model.isCustom)).toBe(true);
  });

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
            { group: "Flash", name: "Flash", options: [modelOptions[3]!, modelOptions[4]!] },
            { group: "Pro", name: "Pro", options: [modelOptions[9]!, modelOptions[3]!] },
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
});

it.layer(testLayer)("Antigravity provider snapshots", (it) => {
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

  it.effect("records explicit sign-in while disabled without starting a health probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ enabled: false });
        const signedIn = yield* Stream.toPull(
          harness.provider.snapshot.streamChanges.pipe(
            Stream.filter(
              (snapshot) =>
                snapshot.auth.status === "authenticated" && snapshot.slashCommands.length > 0,
            ),
          ),
        );
        yield* harness.provider.onSessionStarted(started);
        yield* harness.provider.onAvailableCommands(commands);
        const [snapshot] = yield* signedIn;
        expect(snapshot).toMatchObject({
          enabled: false,
          installed: true,
          status: "disabled",
          auth: { status: "authenticated", type: "oauth-personal" },
          workspaceSnapshots: [],
        });
        expect(snapshot.models).toEqual(buildAntigravityModelsFromSession(sessionSetupResult));
        expect(snapshot.slashCommands).toEqual(commands);
        expect((yield* harness.provider.snapshot.refresh).models).toEqual(snapshot.models);
        expect(yield* Ref.get(harness.probeCalls)).toBe(0);
      }),
    ),
  );

  it.effect("treats initialize as installation proof, not account or model discovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
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
          auth: { status: "unknown" },
          models: [],
        });
        expect(yield* Ref.get(harness.probeCalls)).toBe(1);
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
        expect(snapshot.slashCommands).toEqual(commands);
        expect((yield* harness.provider.snapshotForCwd("/workspace")).slashCommands).toEqual(
          commands,
        );
        expect(yield* Ref.get(harness.probeCalls)).toBe(1);
      }),
    ),
  );

  it.effect("does not retain a disposable sign-in workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        yield* harness.provider.onSessionStarted(started);
        yield* harness.provider.onAvailableCommands(commands);
        const snapshot = yield* harness.provider.snapshot.getSnapshot;
        expect(snapshot.models).toHaveLength(11);
        expect(snapshot.slashCommands).toEqual(commands);
        expect(snapshot.workspaceSnapshots).toEqual([]);
      }),
    ),
  );

  it.effect("clears all account metadata on sign-out and authentication failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        for (const clear of [harness.provider.onSignedOut, harness.provider.onAuthRequired]) {
          yield* harness.provider.onSessionStarted(started, "/workspace");
          yield* harness.provider.onAvailableCommands(commands, "/workspace");
          yield* clear;
          expect(yield* harness.provider.snapshot.getSnapshot).toMatchObject({
            installed: true,
            status: "warning",
            auth: { status: "unauthenticated" },
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
        expect(refreshed.auth.status).toBe("unauthenticated");
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
          slashCommands: commands,
        });
        yield* harness.provider.onConfigOptionsUpdated([]);
        expect((yield* harness.provider.snapshot.getSnapshot).models).toEqual([]);
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
        expect(snapshot.slashCommands).toEqual(commands);
        expect(snapshot.workspaceSnapshots?.[0]?.cwd).toBe("/workspace");
      }),
    ),
  );

  it.effect("allows a slow packaged runtime health check to finish", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        const entered = yield* Deferred.make<void>();
        const initialized = yield* Deferred.make<EffectAcpSchema.InitializeResponse>();
        yield* Ref.set(
          harness.probe,
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(initialized))),
        );

        const refresh = yield* harness.provider.snapshot.refresh.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("47 seconds");
        yield* Deferred.succeed(initialized, initializeResult);
        const snapshot = yield* Fiber.join(refresh);

        expect(snapshot).toMatchObject({
          installed: true,
          status: "warning",
          auth: { status: "unknown" },
        });
      }),
    ),
  );

  it.effect("closes a stalled health probe at its deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.initialize;
        const entered = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        yield* Ref.set(
          harness.probe,
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(closed, undefined)),
          ),
        );
        const refresh = yield* harness.provider.snapshot.refresh.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("90 seconds");
        const snapshot = yield* Fiber.join(refresh);
        yield* Deferred.await(closed);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toContain("90 seconds");
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
        expect(snapshot.slashCommands).toEqual(commands);
        expect(yield* Ref.get(harness.probeCalls)).toBe(1);
      }),
    ),
  );
});
