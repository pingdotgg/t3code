import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderSignInEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexRpc from "effect-codex-app-server/rpc";
import { describe } from "vite-plus/test";

import {
  exitDetail,
  LOGIN_SLOT_WAIT_MS,
  makeCodexAccountOps,
  runCodexLoginHandshake,
  type CodexAccountClient,
} from "./CodexAccountService.ts";
import type { CodexLoginEvent } from "./codexLoginState.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex");

type LoginStartResponse = CodexRpc.ClientRequestResponsesByMethod["account/login/start"];
type LoginCompletedNotification =
  CodexRpc.ServerNotificationParamsByMethod["account/login/completed"];

const BROWSER_RESPONSE: LoginStartResponse = {
  type: "chatgpt",
  loginId: "login-1",
  authUrl: "https://auth.openai.com/oauth?state=abc",
};

const DEVICE_RESPONSE: LoginStartResponse = {
  type: "chatgptDeviceCode",
  loginId: "login-2",
  userCode: "ABCD-EFGHI",
  verificationUrl: "https://auth.openai.com/device",
};

interface FakeCodexAccountClient {
  readonly client: CodexAccountClient;
  readonly calls: Array<{ readonly method: string; readonly payload: unknown }>;
  /** Deliver an `account/login/completed` through the registered handler. */
  readonly notify: (notification: LoginCompletedNotification) => Effect.Effect<void>;
}

function makeFakeClient(options: {
  readonly response?: LoginStartResponse;
  readonly requestFailure?: string;
  /** Fired while the `account/login/start` request is still in flight. */
  readonly notifyDuringStart?: LoginCompletedNotification;
}): FakeCodexAccountClient {
  const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
  let handler:
    | ((notification: LoginCompletedNotification) => Effect.Effect<void, never>)
    | undefined;

  const notify = (notification: LoginCompletedNotification): Effect.Effect<void> =>
    handler === undefined
      ? Effect.die("account/login/completed handler was not registered before the request")
      : (handler(notification) as Effect.Effect<void>);

  const client: CodexAccountClient = {
    request: ((method: string, payload: unknown) => {
      calls.push({ method, payload });
      if (method !== "account/login/start") {
        return Effect.succeed({});
      }
      const before =
        options.notifyDuringStart === undefined ? Effect.void : notify(options.notifyDuringStart);
      return before.pipe(
        Effect.andThen(
          options.requestFailure !== undefined
            ? Effect.fail(
                new CodexErrors.CodexAppServerRequestError({
                  code: -32603,
                  errorMessage: options.requestFailure,
                }),
              )
            : Effect.succeed(options.response ?? BROWSER_RESPONSE),
        ),
      );
    }) as CodexAccountClient["request"],
    handleServerNotification: (_method, nextHandler) =>
      Effect.sync(() => {
        handler = nextHandler as (
          notification: LoginCompletedNotification,
        ) => Effect.Effect<void, never>;
      }),
  };

  return { client, calls, notify };
}

/**
 * Emit recorder that also acts as the test's clock: reacting to an emitted
 * event is how the next protocol step is triggered, so every assertion below
 * is receipt-driven rather than timed.
 */
function makeRecorder(onEvent?: (event: ProviderSignInEvent) => Effect.Effect<void>): {
  readonly emitted: Array<ProviderSignInEvent>;
  readonly emit: (event: ProviderSignInEvent) => Effect.Effect<void>;
} {
  const emitted: Array<ProviderSignInEvent> = [];
  return {
    emitted,
    emit: (event) =>
      Effect.sync(() => {
        emitted.push(event);
      }).pipe(Effect.andThen(onEvent?.(event) ?? Effect.void)),
  };
}

describe("runCodexLoginHandshake", () => {
  it.effect("browser mode walks started → browserHandoff → completed", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient({ response: BROWSER_RESPONSE });
      const events = yield* Queue.unbounded<CodexLoginEvent>();
      const recorder = makeRecorder((event) =>
        event._tag === "browserHandoff" ? fake.notify({ success: true }) : Effect.void,
      );

      const state = yield* runCodexLoginHandshake({
        client: fake.client,
        mode: "browser",
        events,
        emit: recorder.emit,
      }).pipe(Effect.scoped);

      NodeAssert.deepStrictEqual(state, { _tag: "completed" });
      NodeAssert.deepStrictEqual(recorder.emitted, [
        { _tag: "started" },
        { _tag: "browserHandoff", authUrl: "https://auth.openai.com/oauth?state=abc" },
        { _tag: "completed" },
      ]);
      NodeAssert.deepStrictEqual(fake.calls[0], {
        method: "account/login/start",
        payload: { type: "chatgpt" },
      });
    }),
  );

  it.effect("device mode surfaces the user code and verification url", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient({ response: DEVICE_RESPONSE });
      const events = yield* Queue.unbounded<CodexLoginEvent>();
      const recorder = makeRecorder((event) =>
        event._tag === "deviceCode" ? fake.notify({ success: true }) : Effect.void,
      );

      yield* runCodexLoginHandshake({
        client: fake.client,
        mode: "deviceCode",
        events,
        emit: recorder.emit,
      }).pipe(Effect.scoped);

      NodeAssert.deepStrictEqual(recorder.emitted[1], {
        _tag: "deviceCode",
        userCode: "ABCD-EFGHI",
        verificationUrl: "https://auth.openai.com/device",
      });
      NodeAssert.deepStrictEqual(fake.calls[0]?.payload, { type: "chatgptDeviceCode" });
    }),
  );

  it.effect("delivers a completed notification that races ahead of the start response", () =>
    Effect.gen(function* () {
      // The handler must be registered before the request is issued, and the
      // request must not block the loop, or this notification is lost.
      const fake = makeFakeClient({
        response: BROWSER_RESPONSE,
        notifyDuringStart: { success: true },
      });
      const events = yield* Queue.unbounded<CodexLoginEvent>();
      const recorder = makeRecorder();

      const state = yield* runCodexLoginHandshake({
        client: fake.client,
        mode: "browser",
        events,
        emit: recorder.emit,
      }).pipe(Effect.scoped);

      NodeAssert.deepStrictEqual(state, { _tag: "completed" });
      NodeAssert.deepStrictEqual(recorder.emitted, [{ _tag: "started" }, { _tag: "completed" }]);
    }),
  );

  it.effect("turns a failure notification into a failed event carrying the message", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient({ response: DEVICE_RESPONSE });
      const events = yield* Queue.unbounded<CodexLoginEvent>();
      const recorder = makeRecorder((event) =>
        event._tag === "deviceCode"
          ? fake.notify({ success: false, error: "device code expired" })
          : Effect.void,
      );

      const state = yield* runCodexLoginHandshake({
        client: fake.client,
        mode: "deviceCode",
        events,
        emit: recorder.emit,
      }).pipe(Effect.scoped);

      NodeAssert.deepStrictEqual(state, { _tag: "failed", message: "device code expired" });
      NodeAssert.deepStrictEqual(recorder.emitted.at(-1), {
        _tag: "failed",
        message: "device code expired",
      });
    }),
  );

  it.effect("turns a rejected login request into a failed event", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient({ requestFailure: "login is disabled for this build" });
      const events = yield* Queue.unbounded<CodexLoginEvent>();
      const recorder = makeRecorder();

      const state = yield* runCodexLoginHandshake({
        client: fake.client,
        mode: "browser",
        events,
        emit: recorder.emit,
      }).pipe(Effect.scoped);

      NodeAssert.equal(state._tag, "failed");
      NodeAssert.match(
        state._tag === "failed" ? state.message : "",
        /login is disabled for this build/,
      );
      NodeAssert.equal(
        fake.calls.some((call) => call.method === "account/login/cancel"),
        false,
      );
    }),
  );

  it.effect("cancels the login with its loginId when the scope closes early", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient({ response: BROWSER_RESPONSE });
      const events = yield* Queue.unbounded<CodexLoginEvent>();
      const handedOff = yield* Deferred.make<void>();
      const recorder = makeRecorder((event) =>
        event._tag === "browserHandoff"
          ? Deferred.succeed(handedOff, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );

      const fiber = yield* runCodexLoginHandshake({
        client: fake.client,
        mode: "browser",
        events,
        emit: recorder.emit,
      }).pipe(Effect.scoped, Effect.forkChild);

      yield* Deferred.await(handedOff);
      yield* Fiber.interrupt(fiber);

      NodeAssert.deepStrictEqual(fake.calls.at(-1), {
        method: "account/login/cancel",
        payload: { loginId: "login-1" },
      });
    }),
  );

  it.effect("does not cancel a login that already completed", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient({ response: BROWSER_RESPONSE });
      const events = yield* Queue.unbounded<CodexLoginEvent>();
      const recorder = makeRecorder((event) =>
        event._tag === "browserHandoff" ? fake.notify({ success: true }) : Effect.void,
      );

      yield* runCodexLoginHandshake({
        client: fake.client,
        mode: "browser",
        events,
        emit: recorder.emit,
      }).pipe(Effect.scoped);

      NodeAssert.deepStrictEqual(
        fake.calls.map((call) => call.method),
        ["account/login/start"],
      );
    }),
  );

  it.effect("reports a child process that dies mid-handshake", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient({ response: BROWSER_RESPONSE });
      const events = yield* Queue.unbounded<CodexLoginEvent>();
      const recorder = makeRecorder((event) =>
        event._tag === "browserHandoff"
          ? Queue.offer(events, {
              _tag: "aborted",
              detail: exitDetail("code 1", "error: CODEX_HOME is not writable"),
            }).pipe(Effect.asVoid)
          : Effect.void,
      );

      const state = yield* runCodexLoginHandshake({
        client: fake.client,
        mode: "browser",
        events,
        emit: recorder.emit,
      }).pipe(Effect.scoped);

      NodeAssert.equal(state._tag, "failed");
      NodeAssert.match(state._tag === "failed" ? state.message : "", /CODEX_HOME is not writable/);
      // No cancel is attempted: the abort moved the login into a terminal
      // state, and there is no live process left to cancel against anyway.
      NodeAssert.deepStrictEqual(
        fake.calls.map((call) => call.method),
        ["account/login/start"],
      );
    }),
  );
});

describe("exitDetail", () => {
  it("quotes the stderr tail only when there is one", () => {
    NodeAssert.equal(
      exitDetail("code 1", "   "),
      "codex app-server exited with code 1 before the sign-in completed.",
    );
    NodeAssert.equal(
      exitDetail("code 1", "boom"),
      "codex app-server exited with code 1 before the sign-in completed.\nboom",
    );
  });
});

describe("makeCodexAccountOps", () => {
  const makeHangingSpawner = (spawnCalled: Deferred.Deferred<void>) =>
    ChildProcessSpawner.make(() =>
      Deferred.succeed(spawnCalled, undefined).pipe(Effect.andThen(Effect.never)),
    );

  const opsInput = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) => ({
    instanceId: INSTANCE_ID,
    binaryPath: "codex",
    homePath: "/tmp/codex-shadow-home",
    launchArgs: undefined,
    cwd: "/tmp",
    environment: undefined,
    spawner,
  });

  it.effect("advertises both sign-in modes", () =>
    Effect.gen(function* () {
      const spawnCalled = yield* Deferred.make<void>();
      const ops = yield* makeCodexAccountOps(opsInput(makeHangingSpawner(spawnCalled)));

      NodeAssert.deepStrictEqual([...ops.authMethods], ["browser", "deviceCode"]);
    }),
  );

  // fork: f1 — the guard QUEUES first and only refuses after the wait window,
  // so the dialog's "Try again" / mode switch does not race the previous
  // login's teardown (cancel RPC + up-to-2s force kill) into a spurious
  // "already in progress".
  it.effect("refuses a second sign-in only after waiting out the slot", () =>
    Effect.gen(function* () {
      const spawnCalled = yield* Deferred.make<void>();
      const ops = yield* makeCodexAccountOps(opsInput(makeHangingSpawner(spawnCalled)));

      // The first login parks inside `spawn`, holding the in-flight guard.
      const first = yield* ops
        .startSignIn({ mode: "deviceCode" })
        .pipe(Stream.runDrain, Effect.forkChild);
      yield* Deferred.await(spawnCalled);

      const refusal = yield* Ref.make<{
        readonly _tag: string;
        readonly instanceId?: string;
      } | null>(null);
      const second = yield* ops.startSignIn({ mode: "deviceCode" }).pipe(
        Stream.runDrain,
        Effect.flip,
        Effect.tap((error) => Ref.set(refusal, error)),
        Effect.forkChild,
      );

      // Still waiting, not refused, while the window is open.
      yield* TestClock.adjust(Duration.millis(LOGIN_SLOT_WAIT_MS - 1));
      NodeAssert.equal(yield* Ref.get(refusal), null);

      yield* TestClock.adjust(Duration.millis(2));
      const error = yield* Ref.get(refusal);

      NodeAssert.equal(error?._tag, "ProviderAuthLoginInProgressError");
      NodeAssert.equal(error?.instanceId, INSTANCE_ID);

      yield* Fiber.interrupt(second);
      yield* Fiber.interrupt(first);
    }),
  );

  it.effect("hands the slot to a login that started while the previous one tore down", () =>
    Effect.gen(function* () {
      const spawnCalled = yield* Deferred.make<void>();
      const ops = yield* makeCodexAccountOps(opsInput(makeHangingSpawner(spawnCalled)));

      const first = yield* ops
        .startSignIn({ mode: "browser" })
        .pipe(Stream.runDrain, Effect.forkChild);
      yield* Deferred.await(spawnCalled);

      const refusal = yield* Ref.make<{
        readonly _tag: string;
        readonly instanceId?: string;
      } | null>(null);
      const second = yield* ops.startSignIn({ mode: "deviceCode" }).pipe(
        Stream.runDrain,
        Effect.flip,
        Effect.tap((error) => Ref.set(refusal, error)),
        Effect.forkChild,
      );
      // The previous login lets go part-way through the wait window.
      yield* Fiber.interrupt(first);
      yield* TestClock.adjust(Duration.millis(LOGIN_SLOT_WAIT_MS * 2));

      // It got the slot: it is running (parked in `spawn`), not refused.
      NodeAssert.equal(yield* Ref.get(refusal), null);
      yield* Fiber.interrupt(second);
    }),
  );

  it.effect("releases the guard once a login stream is torn down", () =>
    Effect.gen(function* () {
      const spawnCalled = yield* Deferred.make<void>();
      const ops = yield* makeCodexAccountOps(opsInput(makeHangingSpawner(spawnCalled)));

      const first = yield* ops
        .startSignIn({ mode: "browser" })
        .pipe(Stream.runDrain, Effect.forkChild);
      yield* Deferred.await(spawnCalled);
      yield* Fiber.interrupt(first);

      const secondSpawnCalled = yield* Ref.make(false);
      const second = yield* ops.startSignIn({ mode: "browser" }).pipe(
        Stream.runDrain,
        Effect.tap(() => Ref.set(secondSpawnCalled, true)),
        Effect.forkChild,
      );

      // No `ProviderAuthLoginInProgressError`: the guard was released by the
      // first stream's finalizer, so the second login gets to run.
      yield* Deferred.await(spawnCalled);
      yield* Fiber.interrupt(second);
      NodeAssert.equal(yield* Ref.get(secondSpawnCalled), false);
    }),
  );
});
