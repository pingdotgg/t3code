import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as AcpSchema from "effect-acp/compat";
import { type AcpError, AcpRequestError } from "effect-acp/errors";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { formatFailureDetail, makeAcpRegistryAuth } from "./auth.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const instanceId = ProviderInstanceId.make("acp-auth-test");
const browserMethod = { id: "browser", name: "Browser", type: "agent" as const };
// CodeBuddy Code 2.181.0 blocks in authenticate until browser login completes.
const codebuddyMethod = { id: "internal", name: "CodeBuddy", type: "agent" as const };
const terminalMethod = {
  id: "terminal",
  name: "Terminal",
  type: "terminal" as const,
  args: ["login"],
  env: { LOGIN: "yes", OVERRIDE: "method" },
};
const resolved: AcpRegistrySupport.ResolvedAcpRegistryAgent = {
  agent: {
    id: "test-agent",
    name: "Test",
    version: "1.0.0",
    description: "Test",
    distribution: {},
  },
  distribution: "binary",
  spawn: {
    command: "/managed/agent",
    args: ["--acp"],
    env: { OVERRIDE: "spawn", AGENT_HOME: "/custom/home" },
  },
};
const catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
  inspect: () =>
    Effect.succeed({
      status: "ready",
      agentId: "test-agent",
      version: "1.0.0",
      distribution: "binary",
    }),
  resolve: () => Effect.succeed(resolved),
  search: () => Effect.die("unused"),
  prepare: () => Effect.die("unused"),
  uninstallManagedBinary: () => Effect.die("unused"),
};

const makeHarness = (
  method: AcpSchema.AuthMethod,
  failVerification = false,
  settings = decodeSettings({ agentId: "test-agent" }),
  providerInstanceId = instanceId,
  authenticateError?: AcpRequestError,
) =>
  Effect.gen(function* () {
    const verify = yield* Deferred.make<void>();
    const changed: boolean[] = [];
    const closed: number[] = [];
    const authenticated: string[] = [];
    const started: number[] = [];
    let runtimes = 0;
    let version = "1.0.0";
    let terminalSpawn: PtyAdapter.PtySpawnInput | undefined;
    let data: ((data: string) => void) | undefined;
    let exit: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
    let killed = false;
    let closedBeforeTerminal = false;
    const written: string[] = [];
    const sizes: number[][] = [];
    const authenticating = yield* Deferred.make<void>();
    const loginFinished = yield* Deferred.make<void>();
    const extNotifications = new Map<string, (params: unknown) => Effect.Effect<void, AcpError>>();
    const controller = yield* makeAcpRegistryAuth({
      instanceId: providerInstanceId,
      settings,
      cwd: "/workspace",
      environment: { PATH: "/tools", OVERRIDE: "base" },
      onChanged: (value) =>
        Effect.sync(() => {
          changed.push(value);
        }),
      makeRuntime: () =>
        Effect.gen(function* () {
          const id = ++runtimes;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed.push(id);
            }),
          );
          const initialized: AcpSchema.InitializeResponse = {
            protocolVersion: 2,
            agentCapabilities: {},
            authMethods: [{ ...method, name: `${method.name} ${version}` }],
          };
          let elicitation:
            | Parameters<AcpSessionRuntime.AcpSessionRuntime["Service"]["handleElicitation"]>[0]
            | undefined;
          const handleExtNotification: AcpSessionRuntime.AcpSessionRuntime["Service"]["handleExtNotification"] =
            (method, payload, handler) =>
              Effect.sync(() => {
                extNotifications.set(method, (params) =>
                  Schema.decodeUnknownEffect(payload)(params).pipe(
                    Effect.orDie,
                    Effect.flatMap(handler),
                  ),
                );
              });
          return {
            initialize: () => Effect.succeed(initialized),
            handleExtNotification,
            handleElicitation: (handler) =>
              Effect.sync(() => {
                elicitation = handler;
              }),
            authenticate: (methodId) =>
              Effect.gen(function* () {
                authenticated.push(methodId);
                if (authenticateError !== undefined) {
                  return yield* authenticateError;
                }
                if (methodId === codebuddyMethod.id) {
                  yield* Deferred.succeed(authenticating, undefined);
                  return yield* Deferred.await(loginFinished);
                }
                if (elicitation)
                  yield* elicitation(
                    {
                      mode: "url",
                      url: "https://example.com/login",
                      elicitationId: "consent",
                      requestId: "login",
                      message: "Sign in",
                    },
                    { requestId: "login", method: "elicitation/create" },
                  );
              }),
            start: () =>
              Effect.gen(function* () {
                started.push(id);
                yield* Deferred.await(verify);
                if (failVerification)
                  return yield* new AcpRequestError({
                    method: "session/new",
                    code: -32000,
                    errorMessage: "Authentication required",
                  });
                return {
                  sessionId: "verified",
                  initializeResult: initialized,
                  sessionSetupResult: { sessionId: "verified" },
                  modelConfigId: undefined,
                };
              }),
            logout: Effect.succeed({}),
          };
        }),
    }).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
        ...catalog,
        inspect: () =>
          Effect.sync(() => ({
            status: "ready" as const,
            agentId: "test-agent",
            version,
            distribution: "binary" as const,
          })),
      }),
      Effect.provideService(PtyAdapter.PtyAdapter, {
        spawn: (input) =>
          Effect.sync(() => {
            terminalSpawn = input;
            closedBeforeTerminal = closed.includes(runtimes);
            return {
              pid: 123,
              write: (input) => {
                written.push(input);
              },
              resize: (cols, rows) => {
                sizes.push([cols, rows]);
              },
              kill: () => {
                killed = true;
              },
              onData: (callback) => {
                data = callback;
                return () => {
                  data = undefined;
                };
              },
              onExit: (callback) => {
                exit = callback;
                return () => {
                  exit = undefined;
                };
              },
            };
          }),
      }),
    );
    const state = (predicate: (state: ProviderAuthState) => boolean) =>
      controller
        .subscribe("owner")
        .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
    const phase = (phase: ProviderAuthState["phase"]) => state((value) => value.phase === phase);
    yield* state((value) => (value.methods?.length ?? 0) > 0);
    return {
      controller,
      verify,
      changed,
      closed,
      authenticated,
      started,
      phase,
      state,
      terminalSpawn: () => terminalSpawn,
      closedBeforeTerminal: () => closedBeforeTerminal,
      data: (value: string) => data?.(value),
      exit: (exitCode: number) => exit?.({ exitCode, signal: null }),
      killed: () => killed,
      written,
      sizes,
      runtimes: () => runtimes,
      authenticating,
      // The ACP client drops extension notifications nobody registered for.
      notify: (method: string, params: unknown) =>
        extNotifications.get(method)?.(params) ?? Effect.void,
      setVersion: (value: string) => {
        version = value;
      },
    };
  }).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog));

it.effect("keeps local credentials separate from a matching registry agent ID", () =>
  Effect.gen(function* () {
    const registry = yield* makeHarness(browserMethod);
    const local = yield* makeHarness(
      browserMethod,
      false,
      decodeSettings({ source: "local", commandPath: "/different/agent" }),
      ProviderInstanceId.make("test-agent"),
    );
    assert.deepEqual(registry.controller.credentialBinding, {
      owner: "provider",
      key: "acp:test-agent",
    });
    assert.deepEqual(local.controller.credentialBinding, {
      owner: "provider",
      key: "acp:local:test-agent",
    });
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "discovers methods without signing in, then waits for browser consent and session verification",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(browserMethod);
      assert.deepEqual(h.authenticated, []);
      assert.deepEqual(h.started, []);
      assert.deepEqual(h.closed, [1]);
      const flow = yield* h.controller.start("owner", Effect.void, "browser");
      const waiting = yield* h.phase("waiting");
      assert.deepEqual(waiting.interaction, {
        type: "browser",
        id: "consent",
        url: "https://example.com/login",
        requiresConsent: true,
      });
      yield* h.controller.respond!("owner", {
        instanceId,
        flowId: flow.flowId!,
        interactionId: "consent",
        response: { type: "browser", action: "accept" },
      });
      yield* h.phase("verifying");
      assert.deepEqual(h.changed, []);
      yield* Deferred.succeed(h.verify, undefined);
      yield* h.phase("succeeded");
      assert.deepEqual(h.authenticated, ["browser"]);
      assert.deepEqual(h.changed, [true]);
      assert.deepEqual(h.closed, [1, 2]);
      yield* h.controller.logout(Effect.void);
      assert.deepEqual(h.changed, [true, false]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("shows the login URL CodeBuddy sends while authenticate is still pending", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(codebuddyMethod);
    const flow = yield* h.controller.start("owner", Effect.void, codebuddyMethod.id);
    yield* Deferred.await(h.authenticating);
    const authUrl = "https://copilot.tencent.com/login?platform=CLI&state=opaque&version=2.181.0";
    yield* h.notify("_codebuddy.ai/authUrl", { authUrl, provider: "external" });
    const current = yield* h.state(() => true);
    assert.strictEqual(current.phase, "waiting");
    assert.deepInclude(current.interaction, { type: "browser", url: authUrl });
    yield* h.controller.cancel("owner", flow.flowId!);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "runs terminal auth directly with the resolved environment and reconnects to verify",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(terminalMethod);
      const flow = yield* h.controller.start("owner", Effect.void, "terminal");
      yield* h.phase("waiting");
      assert.isTrue(h.closedBeforeTerminal());
      assert.deepEqual(h.terminalSpawn(), {
        shell: "/managed/agent",
        args: ["--acp", "login"],
        cwd: "/workspace",
        cols: 80,
        rows: 24,
        env: { PATH: "/tools", OVERRIDE: "method", AGENT_HOME: "/custom/home", LOGIN: "yes" },
      });
      h.data("Enter code: ");
      const output = yield* h.state(
        (value) =>
          value.interaction?.type === "terminal" && value.interaction.output === "Enter code: ",
      );
      assert.strictEqual(
        output.interaction?.type === "terminal" && output.interaction.outputOffset,
        12,
      );
      yield* h.controller.respond!("owner", {
        instanceId,
        flowId: flow.flowId!,
        interactionId: "terminal",
        response: { type: "terminal", data: "123\r", size: { cols: 100, rows: 30 } },
      });
      assert.deepEqual(h.written, ["123\r"]);
      assert.deepEqual(h.sizes, [[100, 30]]);
      h.exit(0);
      yield* h.phase("verifying");
      assert.isTrue(h.killed());
      assert.deepEqual(h.authenticated, []);
      yield* Deferred.succeed(h.verify, undefined);
      yield* h.phase("succeeded");
      assert.deepEqual(h.started, [3]);
      assert.deepEqual(h.changed, [true]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("cancels the login PTY and rejects further terminal input", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(terminalMethod);
    const flow = yield* h.controller.start("owner");
    yield* h.phase("waiting");
    yield* h.controller.cancel("owner", flow.flowId!);
    assert.isTrue(h.killed());
    assert.deepEqual(h.started, []);
    assert.deepEqual(h.changed, []);
    assert.strictEqual(
      (yield* h.controller.respond!("owner", {
        instanceId,
        flowId: flow.flowId!,
        interactionId: "terminal",
        response: { type: "terminal", data: "late\r" },
      }).pipe(Effect.result))._tag,
      "Failure",
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("does not report authentication when post-login verification fails", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(terminalMethod, true);
    yield* h.controller.start("owner");
    yield* h.phase("waiting");
    h.exit(0);
    yield* h.phase("verifying");
    yield* Deferred.succeed(h.verify, undefined);
    const failed = yield* h.phase("failed");
    assert.deepEqual(h.changed, []);
    assert.isTrue(h.killed());
    assert.strictEqual(
      failed.message,
      "The provider could not create a session after terminal sign-in. Authentication required",
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("surfaces the agent error message when authenticate fails with AcpRequestError", () =>
  Effect.gen(function* () {
    const error = new AcpRequestError({
      method: "authenticate",
      code: -32000,
      errorMessage: "Connect to the VPN, then sign in again.",
    });
    const h = yield* makeHarness(
      browserMethod,
      false,
      decodeSettings({ agentId: "test-agent" }),
      instanceId,
      error,
    );
    yield* h.controller.start("owner", Effect.void, "browser");
    const failed = yield* h.phase("failed");
    assert.strictEqual(
      failed.message,
      "The ACP agent could not complete sign-in. Connect to the VPN, then sign in again.",
    );
    assert.deepEqual(h.changed, []);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "surfaces the agent error message when post-sign-in verification fails for agent auth",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(browserMethod, true);
      const flow = yield* h.controller.start("owner", Effect.void, "browser");
      yield* h.phase("waiting");
      yield* h.controller.respond!("owner", {
        instanceId,
        flowId: flow.flowId!,
        interactionId: "consent",
        response: { type: "browser", action: "accept" },
      });
      yield* h.phase("verifying");
      yield* Deferred.succeed(h.verify, undefined);
      const failed = yield* h.phase("failed");
      assert.strictEqual(
        failed.message,
        "The provider could not create a session after sign-in. Authentication required",
      );
      assert.deepEqual(h.changed, []);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it("formatFailureDetail handles all cause types and formatting edge cases cleanly", () => {
  const baseWithPeriod = "The ACP agent could not complete sign-in.";
  const baseWithoutPeriod = "The ACP agent could not complete sign-in";

  // 1. undefined or null cause
  assert.strictEqual(formatFailureDetail(baseWithPeriod, undefined), baseWithPeriod);
  assert.strictEqual(formatFailureDetail(baseWithPeriod, null), baseWithPeriod);

  // 2. plain Error object, string, number, or object defect
  assert.strictEqual(
    formatFailureDetail(baseWithPeriod, new Error("Something broke")),
    baseWithPeriod,
  );
  assert.strictEqual(formatFailureDetail(baseWithPeriod, "string error"), baseWithPeriod);
  assert.strictEqual(formatFailureDetail(baseWithPeriod, { foo: "bar" }), baseWithPeriod);

  // 3. AcpRequestError with empty or whitespace-only errorMessage
  const emptyError = new AcpRequestError({
    method: "authenticate",
    code: -32000,
    errorMessage: "",
  });
  const whitespaceError = new AcpRequestError({
    method: "authenticate",
    code: -32000,
    errorMessage: "   \t\n  ",
  });
  assert.strictEqual(formatFailureDetail(baseWithPeriod, emptyError), baseWithPeriod);
  assert.strictEqual(formatFailureDetail(baseWithPeriod, whitespaceError), baseWithPeriod);

  // 4. AcpRequestError with valid message: ensure no double periods, clean separation
  const validError = new AcpRequestError({
    method: "authenticate",
    code: -32000,
    errorMessage: "Connect to the VPN, then sign in again.",
  });
  assert.strictEqual(
    formatFailureDetail(baseWithPeriod, validError),
    "The ACP agent could not complete sign-in. Connect to the VPN, then sign in again.",
  );
  assert.strictEqual(
    formatFailureDetail(baseWithoutPeriod, validError),
    "The ACP agent could not complete sign-in. Connect to the VPN, then sign in again.",
  );

  // 5. AcpRequestError with trimmed message and message without ending period
  const unpunctError = new AcpRequestError({
    method: "authenticate",
    code: -32000,
    errorMessage: "  Invalid credentials  ",
  });
  assert.strictEqual(
    formatFailureDetail(baseWithPeriod, unpunctError),
    "The ACP agent could not complete sign-in. Invalid credentials",
  );

  // 6. Nested Cause (e.g. Cause.fail or Cause.die wrapping AcpRequestError)
  assert.strictEqual(
    formatFailureDetail(baseWithPeriod, Cause.fail(validError)),
    "The ACP agent could not complete sign-in. Connect to the VPN, then sign in again.",
  );
  assert.strictEqual(
    formatFailureDetail(baseWithPeriod, Cause.die(validError)),
    "The ACP agent could not complete sign-in. Connect to the VPN, then sign in again.",
  );

  // 7. Extremely long error message: truncates to 500 characters with ellipsis
  const longText = "A".repeat(600);
  const longError = new AcpRequestError({
    method: "authenticate",
    code: -32000,
    errorMessage: longText,
  });
  const expectedLong = `The ACP agent could not complete sign-in. ${"A".repeat(500)}…`;
  assert.strictEqual(formatFailureDetail(baseWithPeriod, longError), expectedLong);
});
