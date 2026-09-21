import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AcpRegistrySettings,
  ProviderInstanceId,
  type ProviderAuthState,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as AcpSchema from "effect-acp/compat";
import { AcpRequestError } from "effect-acp/errors";

import { PtyAdapter, type PtyExitEvent, type PtySpawnInput } from "../../terminal/PtyAdapter.ts";
import { makeAcpRegistryAuth } from "./AcpRegistryAuth.ts";
import { AcpRegistryCatalog, type ResolvedAcpRegistryAgent } from "./AcpRegistrySupport.ts";
import type { AcpSessionRuntime } from "./AcpSessionRuntime.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const instanceId = ProviderInstanceId.make("acp-auth-test");
const browserMethod = { id: "browser", name: "Browser", type: "agent" as const };
const terminalMethod = {
  id: "terminal",
  name: "Terminal",
  type: "terminal" as const,
  args: ["login"],
  env: { LOGIN: "yes", OVERRIDE: "method" },
};
const resolved: ResolvedAcpRegistryAgent = {
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
const catalog: AcpRegistryCatalog["Service"] = {
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

const makeHarness = (method: AcpSchema.AuthMethod, failVerification = false) =>
  Effect.gen(function* () {
    const verify = yield* Deferred.make<void>();
    const changed: boolean[] = [];
    const closed: number[] = [];
    const authenticated: string[] = [];
    const started: number[] = [];
    let runtimes = 0;
    let version = "1.0.0";
    let terminalSpawn: PtySpawnInput | undefined;
    let data: ((data: string) => void) | undefined;
    let exit: ((event: PtyExitEvent) => void) | undefined;
    let killed = false;
    let closedBeforeTerminal = false;
    const written: string[] = [];
    const sizes: number[][] = [];
    const controller = yield* makeAcpRegistryAuth({
      instanceId,
      settings: decodeSettings({ agentId: "test-agent" }),
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
            | Parameters<AcpSessionRuntime["Service"]["handleElicitation"]>[0]
            | undefined;
          return {
            initialize: () => Effect.succeed(initialized),
            handleElicitation: (handler) =>
              Effect.sync(() => {
                elicitation = handler;
              }),
            authenticate: (methodId) =>
              Effect.gen(function* () {
                authenticated.push(methodId);
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
      Effect.provideService(AcpRegistryCatalog, {
        ...catalog,
        inspect: () =>
          Effect.sync(() => ({
            status: "ready" as const,
            agentId: "test-agent",
            version,
            distribution: "binary" as const,
          })),
      }),
      Effect.provideService(PtyAdapter, {
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
      setVersion: (value: string) => {
        version = value;
      },
    };
  }).pipe(Effect.provideService(AcpRegistryCatalog, catalog));

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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not report authentication when post-login verification fails", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(terminalMethod, true);
    yield* h.controller.start("owner");
    yield* h.phase("waiting");
    h.exit(0);
    yield* h.phase("verifying");
    yield* Deferred.succeed(h.verify, undefined);
    yield* h.phase("failed");
    assert.deepEqual(h.changed, []);
    assert.isTrue(h.killed());
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refreshes advertised methods after a registry version change without logging in", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(browserMethod);
    const count = h.runtimes();
    yield* h.controller.refreshMethods!;
    assert.strictEqual(h.runtimes(), count);
    h.setVersion("2.0.0");
    yield* h.controller.refreshMethods!;
    const state = yield* h.state((value) => value.methods?.[0]?.name === "Browser 2.0.0");
    assert.strictEqual(state.phase, "idle");
    assert.strictEqual(h.runtimes(), count + 1);
    assert.deepEqual(h.authenticated, []);
    assert.deepEqual(h.started, []);
    assert.deepEqual(h.closed, [1, 2]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
