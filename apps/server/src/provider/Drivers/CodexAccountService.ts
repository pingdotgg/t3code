/**
 * Codex account lifecycle over the native `codex app-server` protocol
 * (fork f1).
 *
 * `account/login/start`, `account/login/cancel`, `account/logout` and the
 * `account/login/completed` notification are all modelled by the generated
 * client and had zero call sites before this module.
 *
 * ## Process model
 *
 * Neither existing spawn can host a login: the status probe is force-killed
 * after ~2s, and a session runtime is bound to a thread and a cwd that may not
 * exist yet. So each operation gets its own short-lived app-server child,
 * spawned with the instance's **effective** `CODEX_HOME`. Multi-account then
 * falls out for free — `account/login/start` writes into whatever home its
 * process was given, and `CodexHomeLayout` already keeps `auth.json` private
 * per shadow home.
 *
 * ## Cancellation
 *
 * The child's lifetime is the stream's scope. When the client unsubscribes
 * (dialog closed, socket dropped), the scope closes, the finalizer sends
 * `account/login/cancel` with the live `loginId`, and the process is killed.
 * There is no cancel RPC and the client keeps no `loginId` bookkeeping.
 *
 * @module provider/Drivers/CodexAccountService
 */
import {
  PROVIDER_SIGN_IN_MODES,
  ProviderAuthFailedError,
  ProviderAuthLoginInProgressError,
  type ProviderInstanceId,
  type ProviderSignInEvent,
  type ProviderSignInMode,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexRpc from "effect-codex-app-server/rpc";

import { expandHomePath } from "../../pathExpansion.ts";
import type { ProviderAuthOps } from "../ProviderAuthOps.ts";
import { buildCodexInitializeParams } from "../Layers/CodexProvider.ts";
import { codexAppServerArgs } from "../Layers/codexLaunchArgs.ts";
import {
  initialLoginState,
  isTerminalLoginState,
  loginIdOf,
  loginStartParams,
  loginStateSignInEvent,
  nextLoginState,
  type CodexLoginEvent,
  type CodexLoginState,
} from "./codexLoginState.ts";

/**
 * Device codes expire on the order of minutes; this is the hard ceiling that
 * guarantees a wedged child cannot outlive the socket even if the notification
 * never arrives.
 */
export const CODEX_LOGIN_TIMEOUT_MS = 10 * 60_000;

const CODEX_ACCOUNT_FORCE_KILL_AFTER = "2 seconds" as const;

/**
 * fork: f1 — how long a new login WAITS for the previous one's slot before
 * refusing.
 *
 * "Try again" and "Use a device code instead" swap the events atom, so the new
 * `startSignIn` stream opens WHILE the previous one's finalizer chain is still
 * running: `account/login/cancel`, then a child kill that may take the full
 * `CODEX_ACCOUNT_FORCE_KILL_AFTER`. Refusing on sight made both buttons land on
 * "a sign-in is already in progress" for the whole teardown window, which is
 * the common case rather than the rare one. Comfortably longer than the kill
 * timeout, and still short enough that a genuinely concurrent login (two
 * dialogs, two clients) is refused rather than queued forever.
 */
export const LOGIN_SLOT_WAIT_MS = 5_000;

/** How many trailing stderr lines to quote when the child dies mid-handshake. */
const STDERR_TAIL_LINES = 5;

type CodexAccountMethod = "account/login/start" | "account/login/cancel" | "account/logout";

/**
 * The slice of the generated client this module uses. Structural so tests can
 * substitute a recorder without a subprocess — the same shape
 * `CodexSessionRuntime.openCodexThread` uses for `thread/*`.
 */
export interface CodexAccountClient {
  readonly request: <M extends CodexAccountMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
  readonly handleServerNotification: (
    method: "account/login/completed",
    handler: (
      payload: CodexRpc.ServerNotificationParamsByMethod["account/login/completed"],
    ) => Effect.Effect<void, CodexErrors.CodexAppServerError>,
  ) => Effect.Effect<void>;
}

/**
 * Drive one login handshake to a terminal state, emitting wire events as it
 * goes. Pure protocol logic over a structural client and a `CodexLoginEvent`
 * queue — the caller owns the process, the timeout fiber and the child-exit
 * watcher, and feeds them in as `timedOut` / `aborted`.
 *
 * The handler is registered **before** the request is issued and the request
 * itself is forked, because `account/login/completed` can and does race ahead
 * of the `account/login/start` response.
 */
export const runCodexLoginHandshake = Effect.fn("runCodexLoginHandshake")(function* (input: {
  readonly client: CodexAccountClient;
  readonly mode: ProviderSignInMode;
  readonly events: Queue.Queue<CodexLoginEvent>;
  readonly emit: (event: ProviderSignInEvent) => Effect.Effect<void>;
}): Effect.fn.Return<CodexLoginState, never, Scope.Scope> {
  const stateRef = yield* Ref.make<CodexLoginState>(initialLoginState);

  // Scope close IS the cancel. Runs on interruption (client unsubscribed) and
  // on normal completion alike; after a terminal state there is no `loginId`
  // left to cancel, so the success path is a no-op.
  yield* Effect.addFinalizer(() =>
    Ref.get(stateRef).pipe(
      Effect.flatMap((state) => {
        const loginId = loginIdOf(state);
        return loginId === undefined
          ? Effect.void
          : input.client.request("account/login/cancel", { loginId }).pipe(Effect.ignore);
      }),
    ),
  );

  yield* input.client.handleServerNotification("account/login/completed", (notification) =>
    Queue.offer(input.events, {
      _tag: "loginCompletedNotification",
      notification,
    }).pipe(Effect.asVoid),
  );

  yield* input.emit({ _tag: "started" });

  yield* input.client.request("account/login/start", loginStartParams(input.mode)).pipe(
    Effect.matchEffect({
      onSuccess: (response) =>
        Queue.offer(input.events, {
          _tag: "loginStartResponse",
          response: response as CodexRpc.ClientRequestResponsesByMethod["account/login/start"],
        }),
      onFailure: (cause) =>
        Queue.offer(input.events, {
          _tag: "aborted",
          detail: `Codex refused the sign-in request: ${cause.message}`,
        }),
    }),
    Effect.forkScoped,
  );

  let state: CodexLoginState = initialLoginState;
  while (!isTerminalLoginState(state)) {
    const event = yield* Queue.take(input.events);
    const next = nextLoginState(state, event);
    if (next === state) continue;
    state = next;
    yield* Ref.set(stateRef, state);
    const wireEvent = loginStateSignInEvent(state);
    if (wireEvent !== null) {
      yield* input.emit(wireEvent);
    }
  }

  return state;
});

export interface CodexAccountOpsInput {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  /** The instance's `effectiveHomePath` — the shadow home when overlaid. */
  readonly homePath: string | undefined;
  readonly launchArgs: string | undefined;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv | undefined;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}

interface AcquiredCodexAccountClient {
  readonly client: CodexAccountClient;
  /**
   * Resolves when the child exits, with a message quoting its exit code and
   * the tail of its stderr. Parking on this is the only way to notice that the
   * process died while we were waiting on a notification.
   */
  readonly awaitExitDetail: Effect.Effect<string>;
}

const acquireCodexAccountClient = Effect.fn("acquireCodexAccountClient")(function* (
  input: CodexAccountOpsInput,
): Effect.fn.Return<AcquiredCodexAccountClient, ProviderAuthFailedError, Scope.Scope> {
  const failed = (detail: string) =>
    new ProviderAuthFailedError({ instanceId: input.instanceId, detail });

  // `~` is not shell-expanded for env vars set via `child_process.spawn`, so a
  // configured `CODEX_HOME=~/.codex_work` has to be expanded here — same
  // reasoning as `probeCodexAppServerProvider`.
  const resolvedHomePath = input.homePath ? expandHomePath(input.homePath) : undefined;
  const environment = {
    ...input.environment,
    ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
  };
  const spawnCommand = yield* resolveSpawnCommand(
    input.binaryPath,
    codexAppServerArgs(input.launchArgs),
    { env: environment, extendEnv: true },
  );

  const child = yield* input.spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: input.cwd,
        env: environment,
        extendEnv: true,
        forceKillAfter: CODEX_ACCOUNT_FORCE_KILL_AFTER,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        failed(`Could not start \`${input.binaryPath} app-server\`: ${cause.message}`),
      ),
    );

  const stderrLinesRef = yield* Ref.make<ReadonlyArray<string>>([]);
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.update(stderrLinesRef, (lines) =>
        [
          ...lines,
          ...chunk
            .split("\n")
            .map((line) => line.trimEnd())
            .filter(Boolean),
        ].slice(-STDERR_TAIL_LINES),
      ),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );

  yield* client
    .request("initialize", buildCodexInitializeParams())
    .pipe(
      Effect.mapError((cause) => failed(`Codex app-server handshake failed: ${cause.message}`)),
    );
  yield* client
    .notify("initialized", undefined)
    .pipe(
      Effect.mapError((cause) => failed(`Codex app-server handshake failed: ${cause.message}`)),
    );

  return {
    client,
    awaitExitDetail: child.exitCode.pipe(
      Effect.map((exitCode) => `code ${Number(exitCode)}`),
      Effect.orElseSucceed(() => "an unknown code"),
      Effect.flatMap((exitLabel) =>
        Ref.get(stderrLinesRef).pipe(
          Effect.map((lines) => exitDetail(exitLabel, lines.join("\n"))),
        ),
      ),
    ),
  };
});

export function exitDetail(exitLabel: string, stderrTail: string): string {
  const tail = stderrTail.trim();
  const base = `codex app-server exited with ${exitLabel} before the sign-in completed.`;
  return tail.length > 0 ? `${base}\n${tail}` : base;
}

/**
 * Build the account operations for one Codex instance. Called from
 * `CodexDriver.create`, where the spawner and the resolved home layout are
 * already in hand, so the returned ops need no environment of their own.
 */
export const makeCodexAccountOps = Effect.fn("makeCodexAccountOps")(function* (
  input: CodexAccountOpsInput,
): Effect.fn.Return<ProviderAuthOps> {
  // One login at a time per instance: two concurrent handshakes would race on
  // the same private `auth.json`. A semaphore rather than a boolean flag so a
  // login arriving while the previous one is tearing down QUEUES instead of
  // being refused — see `LOGIN_SLOT_WAIT_MS`.
  const loginSlot = yield* Semaphore.make(1);

  const startSignIn = (start: { readonly mode: ProviderSignInMode }) =>
    Stream.callback<ProviderSignInEvent, ProviderAuthLoginInProgressError>((queue) =>
      Effect.gen(function* () {
        const acquired = yield* loginSlot
          .take(1)
          .pipe(Effect.timeoutOption(Duration.millis(LOGIN_SLOT_WAIT_MS)));
        if (Option.isNone(acquired)) {
          return yield* Queue.fail(
            queue,
            new ProviderAuthLoginInProgressError({ instanceId: input.instanceId }),
          );
        }
        yield* Effect.addFinalizer(() => loginSlot.release(1).pipe(Effect.asVoid));

        const emit = (event: ProviderSignInEvent) => Queue.offer(queue, event).pipe(Effect.asVoid);

        yield* Effect.gen(function* () {
          const events = yield* Queue.unbounded<CodexLoginEvent>();
          const acquiredClient = yield* acquireCodexAccountClient(input).pipe(
            Effect.tapError((error) => emit({ _tag: "failed", message: error.detail })),
          );

          // The child dying mid-handshake is otherwise invisible: we would be
          // parked on `Queue.take` with nothing left to notify us.
          yield* acquiredClient.awaitExitDetail.pipe(
            Effect.flatMap((detail) => Queue.offer(events, { _tag: "aborted", detail })),
            Effect.forkScoped,
          );

          yield* Effect.sleep(Duration.millis(CODEX_LOGIN_TIMEOUT_MS)).pipe(
            Effect.andThen(Queue.offer(events, { _tag: "timedOut" })),
            Effect.forkScoped,
          );

          yield* runCodexLoginHandshake({
            client: acquiredClient.client,
            mode: start.mode,
            events,
            emit,
          });
        }).pipe(
          Effect.scoped,
          // A spawn/handshake failure already surfaced as a `failed` event, so
          // the stream ends normally rather than erroring the RPC.
          Effect.catchTag("ProviderAuthFailedError", () => Effect.void),
          Effect.onExit((exit) =>
            exit._tag === "Failure" && !Cause.hasInterrupts(exit.cause)
              ? emit({
                  _tag: "failed",
                  message: `Sign-in stopped unexpectedly: ${Cause.pretty(exit.cause)}`,
                })
              : Effect.void,
          ),
          Effect.andThen(Queue.end(queue)),
          Effect.forkScoped,
        );
      }),
    );

  const signOut = Effect.gen(function* () {
    const acquired = yield* acquireCodexAccountClient(input);
    yield* acquired.client.request("account/logout", undefined).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAuthFailedError({
            instanceId: input.instanceId,
            detail: `Codex sign-out failed: ${cause.message}`,
          }),
      ),
    );
  }).pipe(Effect.scoped);

  return {
    authMethods: PROVIDER_SIGN_IN_MODES,
    startSignIn,
    signOut,
  } satisfies ProviderAuthOps;
});
