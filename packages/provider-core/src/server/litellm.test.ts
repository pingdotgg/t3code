// @effect-diagnostics nodeBuiltinImport:off - fixtures write executable scripts.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  ProviderThreadId,
  ThreadId,
  NodeId,
  type OrchestrationV2ProviderCapabilities,
  type ServerSettings,
  type ProviderAuthState,
  type ServerProvider,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";

import type { ProviderDriver, ProviderDriverCreateInput, ProviderInstance } from "./driver.ts";
import { knownProviderFailureMessage } from "./failure.ts";
import {
  applyLiteLLMStatus,
  liteLLMCallbackTarget,
  liteLLMShimScript,
  liteLLMSignedOutMessage,
  parseLiteLLMModelIds,
  type LiteLLMHarness,
  type LiteLLMStatus,
  withLiteLLMLauncher,
} from "./litellm.ts";
import type {
  ProviderAdapterV2OpenSessionInput,
  ProviderAdapterV2RuntimePolicy,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderHost from "./ProviderHost.ts";
import { spawnAndCollect } from "./snapshotProbe.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const testServices = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const capabilities = createModelCapabilities({ optionDescriptors: [] });
const sonnetCapabilities = createModelCapabilities({
  optionDescriptors: [
    { id: "effort", label: "Reasoning", type: "select", options: [{ id: "high", label: "High" }] },
  ],
});
const instanceId = ProviderInstanceId.make("litellm_claude");

const snapshot = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    {
      slug: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      isCustom: false,
      aliases: ["sonnet-4.5"],
      capabilities: sonnetCapabilities,
    },
    { slug: "my-alias", name: "My alias", isCustom: true, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("applyLiteLLMStatus", () => {
  it("lists gateway models, keeping known entries and user custom models", () => {
    const result = applyLiteLLMStatus(
      snapshot(),
      {
        auth: { status: "authenticated" },
        models: ["gpt-5", "claude-sonnet-4-5", "bedrock/sonnet-4.5", "claude sonnet 4.5"],
      },
      capabilities,
      (id) => id.replace(/^bedrock\//, ""),
    );
    assert.deepEqual(
      result.models.map((model) => [model.slug, model.name, model.isCustom, model.gateway]),
      [
        ["gpt-5", "gpt-5", false, "litellm"],
        ["claude-sonnet-4-5", "Claude Sonnet 4.5", false, "litellm"],
        ["bedrock/sonnet-4.5", "bedrock/sonnet-4.5", false, "litellm"],
        ["claude sonnet 4.5", "claude sonnet 4.5", false, "litellm"],
        ["my-alias", "My alias", true, undefined],
      ],
    );
    assert.strictEqual(result.models[0]?.capabilities, capabilities);
    assert.strictEqual(result.models[2]?.capabilities, sonnetCapabilities);
    assert.strictEqual(result.models[3]?.capabilities, sonnetCapabilities);
  });

  it("marks only the harness-listed models the gateway serves", () => {
    const listed = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });
    const harnessSnapshot = snapshot({
      models: [listed("litellm/gpt-5"), listed("openai/gpt-5"), listed("litellm/retired")],
    });
    const gatewayId = (slug: string) =>
      slug.startsWith("litellm/") ? slug.slice("litellm/".length) : undefined;
    const marks = (status: LiteLLMStatus) =>
      applyLiteLLMStatus(harnessSnapshot, status, undefined, undefined, gatewayId).models.map(
        (model) => [model.slug, model.gateway],
      );
    assert.deepEqual(marks({ auth: { status: "authenticated" }, models: ["gpt-5"] }), [
      ["litellm/gpt-5", "litellm"],
      ["openai/gpt-5", undefined],
      ["litellm/retired", undefined],
    ]);
    // Without the gateway's list, no model can claim to be served by it.
    assert.deepEqual(marks({ auth: { status: "unauthenticated", message: "Signed out." } }), [
      ["litellm/gpt-5", undefined],
      ["openai/gpt-5", undefined],
      ["litellm/retired", undefined],
    ]);
  });

  it("reports the gateway sign-in instead of the harness's own account", () => {
    const signedOut = applyLiteLLMStatus(
      snapshot(),
      { auth: { status: "unauthenticated", message: "LiteLLM: Not authenticated." } },
      null,
    );
    assert.deepEqual(
      [signedOut.status, signedOut.auth.status, signedOut.message],
      ["error", "unauthenticated", "LiteLLM: Not authenticated."],
    );
    assert.equal(signedOut.setup?.canAuthenticate, true);

    const harnessWantsLogin = applyLiteLLMStatus(
      snapshot({
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Log in to Codex",
      }),
      { auth: { status: "authenticated" } },
      undefined,
    );
    assert.deepEqual(
      [harnessWantsLogin.status, harnessWantsLogin.auth.status, harnessWantsLogin.message],
      ["ready", "authenticated", undefined],
    );
  });

  it("reports a failed gateway model list instead of the bundled catalog", () => {
    const result = applyLiteLLMStatus(
      snapshot(),
      { auth: { status: "authenticated" } },
      capabilities,
    );
    assert.equal(result.status, "error");
    assert.deepEqual(
      result.models.map((model) => model.slug),
      ["my-alias"],
    );
  });

  it("keeps a disabled instance quiet", () => {
    const disabled = applyLiteLLMStatus(
      snapshot({ enabled: false, status: "disabled" }),
      { auth: { status: "unauthenticated", message: "LiteLLM: Not authenticated." } },
      null,
    );
    assert.equal(disabled.status, "disabled");
  });
});

describe("lite output parsing", () => {
  it("reads model ids from `lite models list --format json`", () => {
    assert.deepEqual(parseLiteLLMModelIds('[\n  {"id": "gpt-5", "object": "model"}\n]\n'), [
      "gpt-5",
    ]);
    assert.isUndefined(parseLiteLLMModelIds("Traceback (most recent call last):"));
  });

  it("explains a missing gateway URL", () => {
    assert.equal(
      liteLLMSignedOutMessage("Error: Not authenticated for this server.\n", false),
      "LiteLLM: Not authenticated for this server. Set LITELLM_PROXY_URL to your gateway URL.",
    );
  });

  it("only forwards callbacks for this sign-in's loopback listener", () => {
    const authorize =
      "https://gw.example/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Fcallback";
    assert.equal(
      liteLLMCallbackTarget(authorize, "http://localhost:5123/callback?code=c&state=s"),
      "http://127.0.0.1:5123/callback?code=c&state=s",
    );
    assert.isUndefined(liteLLMCallbackTarget(authorize, "http://127.0.0.1:9999/callback?code=c"));
    assert.isUndefined(liteLLMCallbackTarget(authorize, "https://evil.example/callback?code=c"));
  });
});

const FAKE_LITE = `#!/bin/sh
echo "$*" >> "$FAKE_LITE_DIR/calls"
case "$1" in
  version) echo "LiteLLM Proxy CLI Version: \${FAKE_LITE_VERSION:-1.106.2}" ;;
  auth)
    if [ -n "\${FAKE_LITE_RENEWED_EXPIRY-}" ]; then
      mkdir -p "$HOME/.litellm"; echo '{"expires_at": '"$FAKE_LITE_RENEWED_EXPIRY"'}' > "$HOME/.litellm/token.json"
    fi
    if [ -f "$FAKE_LITE_DIR/signed-in" ]; then echo sk-live-key; exit 0; fi
    echo "Error: Not authenticated. Run 'lite login'." >&2; exit 1 ;;
  models) cat "$FAKE_LITE_DIR/models" 2>/dev/null || echo '[{"id": "gpt-5"}]' ;;
  login)
    echo "Opening browser to: https://gw.example/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Fcallback"
    touch "$FAKE_LITE_DIR/signed-in" ;;
  logout) rm -f "$FAKE_LITE_DIR/signed-in" ;;
  *) echo "litellm: routing through proxy"; echo "lite-ran $* OPENCODE_CONFIG_CONTENT=\${OPENCODE_CONFIG_CONTENT-unset} OPENCODE_CONFIG=\${OPENCODE_CONFIG-unset} HEADERS=\${ANTHROPIC_CUSTOM_HEADERS-unset}" ;;
esac
`;

const makeFixture = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-litellm-"));
  const bin = NodePath.join(dir, "bin");
  NodeFS.mkdirSync(bin);
  for (const [name, body] of [
    ["lite", FAKE_LITE],
    ["claude", '#!/bin/sh\necho "2.1.0 (Claude Code)"\n'],
  ] as const) {
    NodeFS.writeFileSync(NodePath.join(bin, name), body, { mode: 0o755 });
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
    FAKE_LITE_DIR: dir,
    HOME: dir,
    LITELLM_PROXY_URL: "https://gw.example",
  };
  return {
    dir,
    environment,
    calls: () => {
      const log = NodePath.join(dir, "calls");
      return NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8").trim().split("\n") : [];
    },
    [Symbol.dispose]: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
};

interface FakeConfig {
  readonly binaryPath: string;
  readonly homePath: string;
}

const titleModels: Array<string> = [];
const startedTurns: Array<string> = [];
const sessionTags: Array<string | undefined> = [];

const sharedCapabilities = {
  sessions: { supportsMultipleProviderThreadsPerSession: true },
} as unknown as OrchestrationV2ProviderCapabilities;

const fakeAdapter = {
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  getCapabilities: () => Effect.succeed(sharedCapabilities),
  openSession: (input: ProviderAdapterV2OpenSessionInput) =>
    Effect.sync(
      () => void sessionTags.push(input.runtimePolicy.launchEnvironment?.LITELLM_REQUEST_TAGS),
    ).pipe(
      Effect.as({
        providerSessionId: input.providerSessionId,
        events: Stream.empty,
        providerSession: { capabilities: sharedCapabilities },
        startTurn: (turn: ProviderAdapterV2TurnInput) =>
          Effect.sync(() => void startedTurns.push(turn.modelSelection.model)),
      } as unknown as ProviderAdapterV2SessionRuntime),
    ),
} as unknown as ProviderInstance["orchestrationAdapter"];

const signIn = (fixture: ReturnType<typeof makeFixture>) =>
  NodeFS.writeFileSync(NodePath.join(fixture.dir, "signed-in"), "");
const setGatewayModels = (fixture: ReturnType<typeof makeFixture>, ids: ReadonlyArray<string>) =>
  NodeFS.writeFileSync(
    NodePath.join(fixture.dir, "models"),
    JSON.stringify(ids.map((id) => ({ id }))),
  );
const writeKeyExpiry = (fixture: ReturnType<typeof makeFixture>, expiresAt: number) => {
  const tokenPath = NodePath.join(fixture.dir, ".litellm", "token.json");
  NodeFS.mkdirSync(NodePath.dirname(tokenPath), { recursive: true });
  NodeFS.writeFileSync(tokenPath, JSON.stringify({ expires_at: expiresAt, base_url: "x" }));
};
const farExpiry = Math.floor(Date.UTC(2099, 0, 1) / 1_000);

const makeInnerDriver = (
  created: Array<ProviderDriverCreateInput<FakeConfig>>,
  events = Stream.empty as Stream.Stream<import("./ProviderAdapter.ts").ProviderAdapterV2Event>,
  runtimeOverrides: Partial<ProviderAdapterV2SessionRuntime> = {},
) =>
  ({
    driverKind: ProviderDriverKind.make("claudeAgent"),
    metadata: { displayName: "Fake" },
    configSchema: Schema.Struct({ binaryPath: Schema.String, homePath: Schema.String }),
    defaultConfig: () => ({ binaryPath: "claude", homePath: "" }),
    create: (input) =>
      Effect.sync(() => {
        created.push(input);
        const current = Effect.succeed(snapshot({ auth: { status: "unknown" } }));
        return {
          instanceId: input.instanceId,
          driverKind: ProviderDriverKind.make("claudeAgent"),
          continuationIdentity: {
            driverKind: ProviderDriverKind.make("claudeAgent"),
            continuationKey: "fake",
          },
          displayName: input.displayName,
          enabled: input.enabled,
          snapshot: {
            resolveMaintenance: () => Effect.die("unused"),
            getSnapshot: current,
            refresh: current,
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {
            ...fakeAdapter,
            openSession: (session) =>
              fakeAdapter.openSession(session).pipe(
                Effect.map((runtime) => ({
                  ...runtime,
                  ...runtimeOverrides,
                  events,
                  subscribeEvents: Effect.succeed({ events, close: Effect.void }),
                })),
              ),
          },
          textGeneration: {
            generateTranscriptionPostProcessing: () => Effect.die("unused"),
            generateCommitMessage: () => Effect.die("unused"),
            generatePrContent: () => Effect.die("unused"),
            generateBranchName: () => Effect.die("unused"),
            generateReviewGuide: () => Effect.die("unused"),
            generateThreadTitle: (request) =>
              Effect.sync(() => {
                titleModels.push(request.modelSelection.model);
                return { title: "Title" };
              }),
          },
        } satisfies ProviderInstance;
      }),
  }) satisfies ProviderDriver<FakeConfig>;

const createLiteLLMInstance = (
  fixture: ReturnType<typeof makeFixture>,
  created: Array<ProviderDriverCreateInput<FakeConfig>>,
  options: {
    readonly settings?: ServerSettings;
    readonly harness?: LiteLLMHarness;
    readonly events?: Stream.Stream<import("./ProviderAdapter.ts").ProviderAdapterV2Event>;
    readonly httpClient?: HttpClient.HttpClient;
    readonly runtimeOverrides?: Partial<ProviderAdapterV2SessionRuntime>;
  } = {},
) => {
  const settings = options.settings ?? DEFAULT_SERVER_SETTINGS;
  const driver = withLiteLLMLauncher(
    makeInnerDriver(created, options.events, options.runtimeOverrides),
    {
      harness: options.harness ?? "claude",
      configure: (config, launch) =>
        Effect.succeed({ ...config, binaryPath: launch.binaryPath, homePath: launch.homeDir }),
      gatewayModelCapabilities: capabilities,
      ...(options.harness === "opencode"
        ? {
            listedModelGatewayId: (slug: string) =>
              slug.startsWith("litellm/") ? slug.slice("litellm/".length) : undefined,
          }
        : {}),
      servesModel: (model, requested) => model.slug === `my-${requested}`,
    },
  );
  return driver
    .launchers!.litellm!.create({
      instanceId,
      displayName: "LiteLLM Claude",
      environment: Object.entries(fixture.environment)
        .filter(
          ([name]) =>
            name === "PATH" ||
            name === "HOME" ||
            name.startsWith("FAKE_") ||
            name.startsWith("LITELLM"),
        )
        .map(([name, value]) => ({ name, value: value ?? "", sensitive: false })),
      enabled: true,
      config: { binaryPath: "claude", homePath: "" },
    })
    .pipe(
      Effect.provideService(
        ProviderHost.ProviderHost,
        ProviderHost.ProviderHost.of({
          compatibility: () => Effect.undefined,
          paths: {
            cwd: fixture.dir,
            baseDir: fixture.dir,
            stateDir: NodePath.join(fixture.dir, "state"),
            providerStatusCacheDir: NodePath.join(fixture.dir, "cache"),
            attachmentsDir: NodePath.join(fixture.dir, "attachments"),
          },
          settings: {
            get: Effect.succeed(settings),
            withSnapshot: (use) => use(settings),
            changes: Stream.empty,
            subscribe: Effect.succeed(Stream.empty),
          },
          shouldRunBackgroundWork: () => Effect.succeed(true),
          resolveAttachmentPath: () => null,
          credentials: () => Effect.die("unused"),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        options.httpClient ??
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
            ),
          ),
      ),
    );
};

describe.skipIf(windowsHost)("withLiteLLMLauncher", () => {
  it.live("publishes gateway budgets and prices both adapter event subscription paths", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      signIn(fixture);
      const event: import("./ProviderAdapter.ts").ProviderAdapterV2Event = {
        type: "provider_turn.updated",
        driver: ProviderDriverKind.make("claudeAgent"),
        providerTurn: {
          id: ProviderTurnId.make("turn"),
          providerThreadId: ProviderThreadId.make("thread"),
          nodeId: NodeId.make("node"),
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: null,
          completedAt: DateTime.makeUnsafe("2026-11-07T00:00:00Z"),
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            models: ["gpt-5"],
            inputTokens: 100,
            outputTokens: 20,
          },
        },
      };
      for (const harness of ["claude", "codex", "opencode"] as const) {
        const reportedModel = harness === "opencode" ? "litellm/gpt-5" : "gpt-5";
        const usageEvent = {
          ...event,
          providerTurn: {
            ...event.providerTurn,
            runAttemptId: RunAttemptId.make("attempt-1"),
            turnTokenUsage: { ...event.providerTurn.turnTokenUsage!, models: [reportedModel] },
          },
        };
        const instance = yield* createLiteLLMInstance(fixture, [], {
          harness,
          runtimeOverrides: {
            hasPendingBackgroundWork: Effect.succeed(true),
            startTurn: () => Effect.void,
          },
          events: Stream.make(usageEvent),
          httpClient: HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  request.url.endsWith("/user/info")
                    ? { user_id: "u1", user_info: { spend: 2, max_budget: 10 } }
                    : {
                        data: [
                          {
                            model_name: "gpt-5",
                            model_info: {
                              input_cost_per_token: 0.001,
                              output_cost_per_token: 0.002,
                            },
                          },
                        ],
                      },
                ),
              ),
            ),
          ),
        });
        const snapshot = yield* instance.snapshot.getSnapshot;
        assert.equal(snapshot.usageLimits?.windows[0]?.usedPercent, 20);
        const runtime = yield* instance.orchestrationAdapter.openSession({
          threadId: ThreadId.make("app-thread"),
          providerSessionId: ProviderSessionId.make("session"),
          modelSelection: { instanceId, model: "gpt-5" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: fixture.dir,
            requestTags: ["jira:ABC-1"],
          },
        });
        assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
        yield* runtime.startTurn({
          attemptId: RunAttemptId.make("attempt-1"),
          modelSelection: { instanceId, model: "gpt-5" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: fixture.dir,
            requestTags: ["jira:CHANGED"],
          },
        } as unknown as ProviderAdapterV2TurnInput);
        const subscription = yield* runtime.subscribeEvents!;
        for (const stream of [runtime.events, subscription.events]) {
          const events = yield* Stream.runCollect(stream);
          const priced = events[0];
          assert.equal(priced?.type, "provider_turn.updated");
          if (priced?.type === "provider_turn.updated") {
            assert.closeTo(priced.providerTurn.turnTokenUsage?.proxyCostUsd ?? -1, 0.14, 1e-10);
            assert.include(
              priced.providerTurn.turnTokenUsage?.proxyRequestTags ?? [],
              harness === "claude" ? "jira:CHANGED" : "jira:ABC-1",
            );
            assert.deepEqual(priced.providerTurn.turnTokenUsage?.models, [reportedModel]);
            assert.include(
              priced.providerTurn.turnTokenUsage?.proxyRequestTags ?? [],
              "tool:T3-Code/claude",
            );
          }
        }
      }
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("launches the harness through a per-instance lite shim", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      const created: Array<ProviderDriverCreateInput<FakeConfig>> = [];
      yield* createLiteLLMInstance(fixture, created);
      const input = created[0]!;
      const shim = input.config.binaryPath;
      assert.equal(
        shim,
        NodePath.join(fixture.dir, "state", "litellm", instanceId, "bin", "claude"),
      );

      const run = (args: ReadonlyArray<string>) =>
        spawnAndCollect(shim, ChildProcess.make(shim, [...args], { env: fixture.environment }));
      assert.equal((yield* run(["--version"])).stdout.trim(), "2.1.0 (Claude Code)");
      assert.include((yield* run(["--print", "hi"])).stdout, "lite-ran claude --print hi");
      assert.notInclude(fixture.calls().join("\n"), "--version");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("signs in with lite login, then reports the gateway account and models", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      const instance = yield* createLiteLLMInstance(fixture, []);

      const signedOut = yield* instance.snapshot.getSnapshot;
      assert.deepEqual([signedOut.auth.status, signedOut.status], ["unauthenticated", "error"]);
      assert.notInclude(JSON.stringify(signedOut), "sk-live-key");

      const owner = "owner";
      const auth = instance.auth!;
      yield* auth.start(owner);
      const finished = yield* auth.subscribe(owner).pipe(
        Stream.filter((state: ProviderAuthState) => state.phase === "succeeded"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      assert.equal(finished.phase, "succeeded");

      const signedIn = yield* instance.snapshot.getSnapshot;
      assert.deepEqual([signedIn.auth.status, signedIn.status], ["authenticated", "ready"]);
      assert.deepEqual(
        signedIn.models.map((model) => model.slug),
        ["gpt-5", "my-alias"],
      );
      assert.include(fixture.calls(), "login --pkce");

      titleModels.length = 0;
      for (const model of ["gpt-6-luna", "my-alias", "alias"]) {
        yield* instance.textGeneration.generateThreadTitle({
          cwd: fixture.dir,
          message: "hi",
          modelSelection: { instanceId, model },
        });
      }
      assert.deepEqual(titleModels, ["gpt-5", "my-alias", "alias"]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("lets lite opencode inject its gateway unless the user set an OpenCode config", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      const shim = NodePath.join(fixture.dir, "opencode-shim");
      NodeFS.writeFileSync(shim, liteLLMShimScript("opencode"), { mode: 0o755 });
      const run = (configContent: string) =>
        spawnAndCollect(
          shim,
          ChildProcess.make(shim, ["serve"], {
            env: { ...fixture.environment, OPENCODE_CONFIG_CONTENT: configContent },
          }),
        );
      assert.include((yield* run("{}")).stdout, "OPENCODE_CONFIG_CONTENT=unset");
      assert.include((yield* run('{"model":"x"}')).stdout, 'OPENCODE_CONFIG_CONTENT={"model":"x"}');
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("renews the key before a session starts inside lite's renewal window", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      signIn(fixture);
      writeKeyExpiry(fixture, farExpiry);
      const generation = (yield* createLiteLLMInstance(fixture, [])).orchestrationAdapter
        .launchGeneration!;
      assert.equal(yield* generation, `${farExpiry}:gpt-5`);
      assert.notInclude(fixture.calls(), "auth print-token renew");

      writeKeyExpiry(fixture, 1);
      fixture.environment.FAKE_LITE_RENEWED_EXPIRY = String(farExpiry + 86_400);
      const renewing = (yield* createLiteLLMInstance(fixture, [])).orchestrationAdapter
        .launchGeneration!;
      assert.equal(yield* renewing, `${farExpiry + 86_400}:gpt-5`);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("starts a new generation when the gateway's model list changes", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      signIn(fixture);
      writeKeyExpiry(fixture, farExpiry);
      const instance = yield* createLiteLLMInstance(fixture, []);
      const before = yield* instance.orchestrationAdapter.launchGeneration!;

      setGatewayModels(fixture, ["gpt-5", "gpt-6"]);
      const refreshed = yield* instance.snapshot.refresh;
      assert.deepEqual(
        refreshed.models.map((model) => model.slug),
        ["gpt-5", "gpt-6", "my-alias"],
      );
      const after = yield* instance.orchestrationAdapter.launchGeneration!;
      assert.notEqual(after, before);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("reports a failed renewal as a sign-out instead of keeping the old generation", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      writeKeyExpiry(fixture, 1);
      const instance = yield* createLiteLLMInstance(fixture, []);
      assert.isUndefined(yield* instance.orchestrationAdapter.launchGeneration!);
      const current = yield* instance.snapshot.getSnapshot;
      assert.deepEqual([current.auth.status, current.status], ["unauthenticated", "error"]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("opens one session per thread and refuses what the gateway cannot serve", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      const instance = yield* createLiteLLMInstance(fixture, []);
      const adapter = instance.orchestrationAdapter;
      const sessionInput = {
        providerSessionId: ProviderSessionId.make("session:litellm"),
        runtimePolicy: { cwd: null },
      } as unknown as ProviderAdapterV2OpenSessionInput;
      const signedOut = yield* adapter.openSession(sessionInput).pipe(Effect.scoped, Effect.flip);
      assert.include(knownProviderFailureMessage(signedOut) ?? "", "Sign in again");

      signIn(fixture);
      yield* instance.snapshot.refresh;
      const capabilities = yield* adapter.getCapabilities();
      assert.isFalse(capabilities.sessions.supportsMultipleProviderThreadsPerSession);
      const runtime = yield* adapter.openSession(sessionInput).pipe(Effect.scoped);

      const turn = (model: string) =>
        ({
          threadId: "thread:1",
          runId: "run:1",
          runtimePolicy: { cwd: null },
          modelSelection: { instanceId, model },
          providerThread: { id: "provider-thread:1" },
        }) as unknown as ProviderAdapterV2TurnInput;
      startedTurns.length = 0;
      yield* runtime.startTurn(turn("gpt-5"));
      const removed = yield* runtime.startTurn(turn("claude-sonnet-4-5")).pipe(Effect.flip);
      assert.include(
        knownProviderFailureMessage(removed) ?? "",
        "no longer serves claude-sonnet-4-5",
      );
      assert.deepEqual(startedTurns, ["gpt-5"]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("tags each session with the repository and the thread's own tags", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      signIn(fixture);
      const repository = NodePath.join(fixture.dir, "checkout");
      NodeFS.mkdirSync(repository);
      const git = (args: ReadonlyArray<string>) =>
        spawnAndCollect("git", ChildProcess.make("git", ["-C", repository, ...args]));
      yield* git(["init", "-q"]);
      yield* git(["remote", "add", "origin", "git@github.com:acme/Widgets.git"]);
      const adapter = (yield* createLiteLLMInstance(fixture, [])).orchestrationAdapter;

      sessionTags.length = 0;
      for (const runtimePolicy of [
        { cwd: repository, requestTags: ["feature-x", "project:billing", "billing"] },
        { cwd: repository, requestTags: ["jira:PROJ-1234", "env:dev", "tool:opencode"] },
        { cwd: repository },
        { cwd: repository, requestTags: [] },
        { cwd: null },
      ])
        yield* adapter
          .openSession({
            providerSessionId: ProviderSessionId.make("session:tags"),
            runtimePolicy,
          } as unknown as ProviderAdapterV2OpenSessionInput)
          .pipe(Effect.scoped);
      assert.deepEqual(sessionTags, [
        "repo:widgets,project:feature-x,project:billing,tool:T3-Code/claude",
        "repo:widgets,jira:PROJ-1234,env:dev,tool:opencode",
        "repo:widgets,project:general-admin,tool:T3-Code/claude",
        "repo:widgets,project:general-admin,tool:T3-Code/claude",
        "project:general-admin,tool:T3-Code/claude",
      ]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("follows the default tag setting, which a live session must notice", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      signIn(fixture);
      const tagsWith = (liteLLMDefaultRequestTag: ServerSettings["liteLLMDefaultRequestTag"]) =>
        createLiteLLMInstance(fixture, [], {
          settings: { ...DEFAULT_SERVER_SETTINGS, liteLLMDefaultRequestTag },
        }).pipe(
          Effect.flatMap(({ orchestrationAdapter }) =>
            Effect.forEach([{ requestTags: [] }, { requestTags: ["billing"] }], (policy) =>
              orchestrationAdapter.launchTags!({
                cwd: null,
                ...policy,
              } as unknown as ProviderAdapterV2RuntimePolicy),
            ),
          ),
        );
      assert.deepEqual(yield* tagsWith({ mode: "custom", custom: "acme" }), [
        "acme,project:general-admin,tool:T3-Code/claude",
        "acme,project:billing,tool:T3-Code/claude",
      ]);
      assert.deepEqual(yield* tagsWith({ mode: "custom", custom: "tool:company" }), [
        "tool:company,project:general-admin",
        "tool:company,project:billing",
      ]);
      assert.deepEqual(yield* tagsWith({ mode: "off", custom: "" }), ["", "project:billing"]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("turns the session's tags into each harness's header setting", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      const run = (harness: "claude" | "codex" | "opencode", tags: string | undefined) => {
        const shim = NodePath.join(fixture.dir, `${harness}-shim`);
        NodeFS.writeFileSync(shim, liteLLMShimScript(harness), { mode: 0o755 });
        const { LITELLM_REQUEST_TAGS: _unset, ...environment } = fixture.environment;
        return spawnAndCollect(
          shim,
          ChildProcess.make(shim, ["app-server"], {
            env: tags === undefined ? environment : { ...environment, LITELLM_REQUEST_TAGS: tags },
          }),
        ).pipe(Effect.map((result) => result.stdout));
      };
      assert.include(
        yield* run("claude", "acme,feature-x"),
        "HEADERS=x-litellm-tags: acme,feature-x",
      );
      assert.include(yield* run("claude", undefined), "HEADERS=unset");
      assert.include(
        yield* run("codex", "acme"),
        `lite-ran codex -c model_providers.litellm.env_http_headers={"x-litellm-tags"="LITELLM_REQUEST_TAGS"} app-server`,
      );
      assert.include(yield* run("codex", undefined), "lite-ran codex app-server");
      assert.include(yield* run("opencode", "acme"), "opencode-request-tags.json");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.live("rejects a lite CLI older than the minimum", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      fixture.environment.FAKE_LITE_VERSION = "1.90.0";
      const instance = yield* createLiteLLMInstance(fixture, []);
      const current = yield* instance.snapshot.getSnapshot;
      assert.include(current.message, "LiteLLM CLI 1.90.0 is too old");
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );
});
