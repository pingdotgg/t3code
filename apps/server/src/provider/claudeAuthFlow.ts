// @effect-diagnostics cryptoRandomUUID:off -- Attempt ids use Web Crypto so the auth capability does not depend on a second service.
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderReauthenticateError,
  ServerProviderReauthenticateStatusResult,
  type ServerProviderReauthenticateAttemptId,
  type ServerProviderReauthenticateCodeInput,
  type ServerProviderUpdatedPayload,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveSpawnCommand } from "@t3tools/shared/shell";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const AUTH_ATTEMPT_TIMEOUT_MS = 5 * 60_000;
const TERMINAL_ATTEMPT_RETENTION_MS = 5 * 60_000;
const MAX_OUTPUT_TAIL_CHARS = 8_192;
// eslint-disable-next-line no-control-regex -- ANSI escape sequences are intentionally removed before URL parsing.
const ansiEscapePattern = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const authorizationUrlPattern = /https?:\/\/[^\s"'<>]+/g;

/**
 * Claude Code prints its authorization URL as part of the interactive login.
 * Keep the parser deliberately narrow: only HTTPS URLs on an Anthropic-owned
 * host are returned to the client, while all other CLI output is discarded.
 * Current and legacy login flows use claude.com, claude.ai, and anthropic.com.
 */
export function extractClaudeAuthorizationUrl(output: string): string | null {
  for (const raw of output.replace(ansiEscapePattern, "").match(authorizationUrlPattern) ?? []) {
    const candidate = raw.replace(/[),.;\]}]+$/g, "");
    try {
      const url = new URL(candidate);
      const hostname = url.hostname.toLowerCase();
      const anthropicHost =
        hostname === "anthropic.com" ||
        hostname.endsWith(".anthropic.com") ||
        hostname === "claude.com" ||
        hostname.endsWith(".claude.com") ||
        hostname === "claude.ai" ||
        hostname.endsWith(".claude.ai");
      if (url.protocol !== "https:" || !anthropicHost || url.username || url.password) {
        continue;
      }
      return url.toString();
    } catch {
      // The CLI may print a URL while it is still writing a chunk. Keep the
      // bounded tail and retry when the next chunk arrives.
    }
  }
  return null;
}

type TerminalStatus = "succeeded" | "failed" | "cancelled" | "expired";

interface AuthAttemptState {
  readonly attemptId: ServerProviderReauthenticateAttemptId;
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly expiresAt: string;
  readonly scope: Scope.Scope;
  readonly completion: Deferred.Deferred<void>;
  readonly ready: Deferred.Deferred<void>;
  readonly onSuccess: () => Effect.Effect<ServerProviderUpdatedPayload>;
  child: ChildProcessSpawner.ChildProcessHandle | undefined;
  status: "starting" | "awaiting_code" | TerminalStatus;
  authorizationUrl: string | null;
  error: string | null;
  providers: ServerProviderUpdatedPayload["providers"] | undefined;
  outputTail: string;
}

export interface ClaudeAuthFlowBeginInput {
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly onSuccess: () => Effect.Effect<ServerProviderUpdatedPayload>;
}

export interface ClaudeAuthFlowShape {
  readonly begin: (
    input: ClaudeAuthFlowBeginInput,
  ) => Effect.Effect<ServerProviderReauthenticateStatusResult, ServerProviderReauthenticateError>;
  readonly submitCode: (
    input: ServerProviderReauthenticateCodeInput,
  ) => Effect.Effect<ServerProviderReauthenticateStatusResult, ServerProviderReauthenticateError>;
  readonly status: (
    attemptId: ServerProviderReauthenticateAttemptId,
  ) => Effect.Effect<ServerProviderReauthenticateStatusResult, ServerProviderReauthenticateError>;
  readonly cancel: (
    attemptId: ServerProviderReauthenticateAttemptId,
  ) => Effect.Effect<ServerProviderReauthenticateStatusResult, ServerProviderReauthenticateError>;
  readonly awaitCompletion: (
    attemptId: ServerProviderReauthenticateAttemptId,
  ) => Effect.Effect<ServerProviderReauthenticateStatusResult, ServerProviderReauthenticateError>;
}

export class ClaudeAuthFlow extends Context.Service<ClaudeAuthFlow, ClaudeAuthFlowShape>()(
  "t3/provider/claudeAuthFlow",
) {}

const isTerminal = (status: AuthAttemptState["status"]): status is TerminalStatus =>
  status === "succeeded" || status === "failed" || status === "cancelled" || status === "expired";

function makeAttemptId(): ServerProviderReauthenticateAttemptId {
  // Attempt ids are bearer capabilities for the code-submission endpoint. The
  // server is normally authenticated already, but an unguessable id prevents
  // one connected client from accidentally addressing another attempt.
  return `${CLAUDE_DRIVER}-${globalThis.crypto.randomUUID()}` as ServerProviderReauthenticateAttemptId;
}

function makeError(reason: string): ServerProviderReauthenticateError {
  return new ServerProviderReauthenticateError({
    provider: CLAUDE_DRIVER,
    reason,
  });
}

function toResult(state: AuthAttemptState): ServerProviderReauthenticateStatusResult {
  return {
    attemptId: state.attemptId,
    provider: state.provider,
    instanceId: state.instanceId,
    threadId: state.threadId,
    status: state.status,
    authorizationUrl: state.authorizationUrl,
    expiresAt: state.expiresAt,
    error: state.error,
    ...(state.providers === undefined ? {} : { providers: state.providers }),
  };
}

function trimOutputTail(previous: string, next: string): string {
  const combined = previous + next;
  return combined.length <= MAX_OUTPUT_TAIL_CHARS
    ? combined
    : combined.slice(combined.length - MAX_OUTPUT_TAIL_CHARS);
}

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const parentScope = yield* Scope.Scope;
  const attemptsRef = yield* Ref.make(new Map<string, AuthAttemptState>());

  const closeAttempt = (state: AuthAttemptState) =>
    Scope.close(state.scope, Exit.void).pipe(Effect.ignore);

  const removeAfterRetention = (state: AuthAttemptState) =>
    Effect.sleep(Duration.millis(TERMINAL_ATTEMPT_RETENTION_MS)).pipe(
      Effect.andThen(
        Ref.update(attemptsRef, (attempts) => {
          if (attempts.get(String(state.attemptId)) !== state) return attempts;
          const next = new Map(attempts);
          next.delete(String(state.attemptId));
          return next;
        }),
      ),
      Effect.asVoid,
      Effect.forkIn(parentScope),
      Effect.asVoid,
    );

  const markTerminal = Effect.fn("ClaudeAuthFlow.markTerminal")(function* (
    state: AuthAttemptState,
    status: TerminalStatus,
    error: string | null,
    providers?: ServerProviderUpdatedPayload["providers"],
  ) {
    if (isTerminal(state.status)) return;
    state.status = status;
    state.error = error;
    state.outputTail = "";
    if (providers !== undefined) state.providers = providers;
    yield* Ref.update(attemptsRef, (attempts) => {
      if (attempts.get(String(state.attemptId)) !== state) return attempts;
      const next = new Map(attempts);
      // A new attempt can reserve the instance as soon as this one becomes
      // terminal. Only remove the alias if it still points at this state.
      if (attempts.get(String(state.instanceId)) === state) {
        next.delete(String(state.instanceId));
      }
      return next;
    });
    yield* Deferred.succeed(state.completion, undefined).pipe(Effect.asVoid);
    yield* Deferred.succeed(state.ready, undefined).pipe(Effect.asVoid);
    if ((status === "cancelled" || status === "expired") && state.child !== undefined) {
      yield* state.child.kill().pipe(Effect.ignore);
    }
    yield* closeAttempt(state);
    yield* removeAfterRetention(state);
  });

  const failUnexpectedly = (state: AuthAttemptState, message: string) =>
    markTerminal(state, "failed", message).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.asVoid,
    );

  const watch = (state: AuthAttemptState) =>
    Effect.gen(function* () {
      const decoder = new TextDecoder();
      const outputFiber = yield* Stream.runForEach(state.child!.all, (chunk) =>
        Effect.gen(function* () {
          const output = decoder.decode(chunk, { stream: true });
          const nextTail = trimOutputTail(state.outputTail, output);
          // A chunk can end in the middle of a URL. Require a line/whitespace
          // boundary before publishing it so a valid prefix such as
          // `https://claude.ai/oauth/author` is never surfaced as the URL.
          const hasOutputBoundary = /\s$/.test(nextTail);
          const url = hasOutputBoundary ? extractClaudeAuthorizationUrl(nextTail) : null;
          state.outputTail = url === null ? nextTail : "";
          if (url !== null && state.authorizationUrl === null) {
            state.authorizationUrl = url;
            if (state.status === "starting") state.status = "awaiting_code";
            yield* Deferred.succeed(state.ready, undefined).pipe(Effect.asVoid);
          }
        }),
      ).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.forkChild,
      );

      const exit = yield* Effect.exit(state.child!.exitCode);
      yield* Fiber.join(outputFiber).pipe(Effect.catchCause(() => Effect.void));

      // If the process closes its output without a trailing newline, the last
      // chunk is still a complete line from the process's perspective. Parse
      // that bounded tail once more after the stream has ended.
      if (state.authorizationUrl === null) {
        const url = extractClaudeAuthorizationUrl(state.outputTail);
        if (url !== null) {
          state.authorizationUrl = url;
          if (state.status === "starting") state.status = "awaiting_code";
          yield* Deferred.succeed(state.ready, undefined).pipe(Effect.asVoid);
        }
      }

      if (Exit.isFailure(exit)) {
        yield* failUnexpectedly(state, "Claude authentication process failed.");
        return;
      }

      // Cancellation/expiry can win after the process exits but before the
      // watcher reaches this branch. Do not refresh or continue a thread for a
      // terminal attempt.
      if (isTerminal(state.status)) return;

      const exitCode = Number(exit.value);
      if (exitCode !== 0) {
        yield* markTerminal(state, "failed", `claude auth login exited with code ${exitCode}.`);
        return;
      }

      const refreshed = yield* state
        .onSuccess()
        .pipe(
          Effect.catchCause(() =>
            Effect.fail(makeError("Claude authentication succeeded, but provider refresh failed.")),
          ),
        );
      yield* markTerminal(state, "succeeded", null, refreshed.providers);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (!isTerminal(state.status)) {
            yield* failUnexpectedly(state, "Claude authentication process failed.");
          }
          // Keep the cause out of logs. A provider CLI can include OAuth
          // state or one-time codes in process errors.
          if (Cause.hasInterrupts(cause)) return;
        }),
      ),
      Effect.asVoid,
    );

  const expire = (state: AuthAttemptState) =>
    Effect.sleep(Duration.millis(AUTH_ATTEMPT_TIMEOUT_MS)).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          if (isTerminal(state.status)) return;
          yield* markTerminal(state, "expired", "Claude authentication timed out after 5 minutes.");
        }),
      ),
      Effect.catchCause(() => Effect.void),
      Effect.forkIn(parentScope),
      Effect.asVoid,
    );

  const getAttempt = Effect.fn("ClaudeAuthFlow.getAttempt")(function* (
    attemptId: ServerProviderReauthenticateAttemptId,
  ) {
    const state = (yield* Ref.get(attemptsRef)).get(String(attemptId));
    if (state === undefined) {
      return yield* makeError("Authentication attempt was not found or has expired.");
    }
    return state;
  });

  const begin: ClaudeAuthFlowShape["begin"] = Effect.fn("ClaudeAuthFlow.begin")(function* (input) {
    if (input.provider !== CLAUDE_DRIVER) {
      return yield* new ServerProviderReauthenticateError({
        provider: input.provider,
        reason: `Reauthentication is not supported for ${input.provider}`,
      });
    }

    const now = yield* DateTime.now;
    const expiresAt = DateTime.formatIso(
      DateTime.add(now, { milliseconds: AUTH_ATTEMPT_TIMEOUT_MS }),
    );
    const attemptId = makeAttemptId();
    const scope = yield* Scope.make("sequential");
    const completion = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<void>();
    const state: AuthAttemptState = {
      attemptId,
      provider: input.provider,
      instanceId: input.instanceId,
      threadId: input.threadId,
      expiresAt,
      scope,
      completion,
      ready,
      onSuccess: input.onSuccess,
      child: undefined,
      status: "starting",
      authorizationUrl: null,
      error: null,
      providers: undefined,
      outputTail: "",
    };

    // Resolve the executable before reserving the instance. A platform-level
    // resolution failure must not leave an invisible single-flight attempt in
    // the registry for the next request.
    const resolved = yield* resolveSpawnCommand(
      input.command,
      input.args,
      input.env === undefined ? undefined : { env: input.env },
    ).pipe(
      Effect.mapError(() => makeError("Failed to prepare claude auth login.")),
      Effect.tapError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
    );

    const existing = yield* Ref.modify(
      attemptsRef,
      (attempts): readonly [AuthAttemptState | undefined, Map<string, AuthAttemptState>] => {
        const active = [...attempts.values()].find(
          (candidate) => candidate.instanceId === input.instanceId && !isTerminal(candidate.status),
        );
        if (active !== undefined) return [active, attempts];
        const next = new Map(attempts);
        next.set(String(attemptId), state);
        next.set(String(input.instanceId), state);
        return [undefined, next];
      },
    );
    if (existing !== undefined) {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
      return yield* makeError(
        "Claude authentication is already in progress for this provider instance.",
      );
    }

    const child = yield* spawner
      .spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          env: input.env,
          shell: resolved.shell,
          stdin: "pipe",
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError(() => makeError("Failed to start claude auth login.")),
        Effect.tapError(() =>
          Ref.update(attemptsRef, (attempts) => {
            const next = new Map(attempts);
            next.delete(String(attemptId));
            next.delete(String(input.instanceId));
            return next;
          }).pipe(Effect.andThen(Scope.close(scope, Exit.void).pipe(Effect.ignore))),
        ),
      );
    state.child = child;

    yield* watch(state).pipe(Effect.forkIn(parentScope));
    yield* expire(state);
    // Claude normally prints the URL immediately. Waiting briefly makes the
    // begin RPC useful to clients that want to open it right away, while the
    // timeout leaves slower installations observable through status polling.
    yield* Deferred.await(state.ready).pipe(
      Effect.timeoutOption(Duration.seconds(10)),
      Effect.asVoid,
    );
    return toResult(state);
  });

  const submitCode: ClaudeAuthFlowShape["submitCode"] = Effect.fn("ClaudeAuthFlow.submitCode")(
    function* (input) {
      const state = yield* getAttempt(input.attemptId);
      if (isTerminal(state.status)) return toResult(state);
      if (state.child === undefined)
        return yield* makeError("Claude authentication is still starting.");

      const writeResult = yield* Effect.exit(
        Stream.run(Stream.encodeText(Stream.make(`${input.code.trim()}\n`)), state.child.stdin),
      );
      if (Exit.isFailure(writeResult)) {
        yield* markTerminal(state, "failed", "Could not submit the Claude authentication code.");
      }
      return toResult(state);
    },
  );

  const status: ClaudeAuthFlowShape["status"] = Effect.fn("ClaudeAuthFlow.status")(
    function* (attemptId) {
      return toResult(yield* getAttempt(attemptId));
    },
  );

  const cancel: ClaudeAuthFlowShape["cancel"] = Effect.fn("ClaudeAuthFlow.cancel")(
    function* (attemptId) {
      const state = yield* getAttempt(attemptId);
      if (!isTerminal(state.status)) {
        yield* markTerminal(state, "cancelled", "Claude authentication was cancelled.");
      }
      return toResult(state);
    },
  );

  const awaitCompletion: ClaudeAuthFlowShape["awaitCompletion"] = Effect.fn(
    "ClaudeAuthFlow.awaitCompletion",
  )(function* (attemptId) {
    const state = yield* getAttempt(attemptId);
    if (!isTerminal(state.status)) yield* Deferred.await(state.completion);
    return toResult(state);
  });

  yield* Scope.addFinalizer(
    parentScope,
    Effect.gen(function* () {
      const attempts = yield* Ref.get(attemptsRef);
      yield* Effect.forEach(new Set(attempts.values()), (state) => closeAttempt(state), {
        concurrency: "unbounded",
        discard: true,
      });
    }),
  );

  return {
    begin,
    submitCode,
    status,
    cancel,
    awaitCompletion,
  } satisfies ClaudeAuthFlowShape;
});

export const layer = Layer.effect(ClaudeAuthFlow, make);
