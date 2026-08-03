import * as NodeCrypto from "node:crypto";

import {
  ProviderAuthError,
  ProviderAuthSessionId,
  type ProviderAuthAttachStreamEvent,
  type ProviderAuthSessionSnapshot,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderAuthSessionManager } from "../Services/ProviderAuthSessionManager.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";

const MAX_HISTORY_LENGTH = 262_144;
const RUNNING_SESSION_TTL = Duration.minutes(30);
const SETTLED_SESSION_TTL = Duration.minutes(10);
const FORCE_KILL_DELAY = Duration.seconds(2);

type Listener = (event: ProviderAuthAttachStreamEvent) => Effect.Effect<void>;

interface Session {
  readonly instance: ProviderInstance;
  readonly process: PtyAdapter.PtyProcess;
  readonly listeners: Set<Listener>;
  snapshot: ProviderAuthSessionSnapshot;
  cancelled: boolean;
  unsubscribeData: () => void;
  unsubscribeExit: () => void;
}

const makeError = (input: {
  readonly reason: ProviderAuthError["reason"];
  readonly message: string;
  readonly instanceId?: ProviderInstanceId;
  readonly sessionId?: ProviderAuthSessionId;
}) => new ProviderAuthError(input);

export const make = Effect.fn("ProviderAuthSessionManager.make")(function* () {
  const pty = yield* PtyAdapter.PtyAdapter;
  const instances = yield* ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const managerScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(managerScope, Exit.void));
  const instanceChanges = yield* instances.subscribeChanges;
  const sessions = new Map<ProviderAuthSessionId, Session>();
  const activeByInstance = new Map<ProviderInstanceId, ProviderAuthSessionId>();
  const startSemaphores = new Map<ProviderInstanceId, Semaphore.Semaphore>();

  const publish = (session: Session, event: ProviderAuthAttachStreamEvent) =>
    Effect.forEach(session.listeners, (listener) => listener(event), {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.ignore);

  const deleteSettledLater = (sessionId: ProviderAuthSessionId) =>
    Effect.sleep(SETTLED_SESSION_TTL).pipe(
      Effect.tap(() => Effect.sync(() => sessions.delete(sessionId))),
      Effect.forkIn(managerScope),
    );

  const settle = Effect.fn("ProviderAuthSessionManager.settle")(function* (
    session: Session,
    exitCode: number | null,
    exitSignal: number | null,
  ) {
    if (session.snapshot.status !== "running") return;
    const finishedAt = DateTime.formatIso(yield* DateTime.now);
    const commandStatus = session.cancelled ? "cancelled" : exitCode === 0 ? "succeeded" : "failed";
    const refreshedProviders = yield* providers.refreshInstance(session.snapshot.instanceId);
    const refreshedAuth = refreshedProviders.find(
      (provider) => provider.instanceId === session.snapshot.instanceId,
    )?.auth.status;
    const verificationFailed =
      commandStatus === "succeeded" &&
      ((session.snapshot.action === "signIn" && refreshedAuth === "unauthenticated") ||
        (session.snapshot.action === "signOut" && refreshedAuth === "authenticated"));
    const status = verificationFailed ? "failed" : commandStatus;
    const message =
      commandStatus === "cancelled"
        ? "Authentication was cancelled."
        : commandStatus === "failed"
          ? `Authentication command exited with code ${exitCode ?? "unknown"}.`
          : verificationFailed
            ? session.snapshot.action === "signIn"
              ? "The command completed, but the provider is still unauthenticated."
              : "The command completed, but the provider still appears authenticated."
            : refreshedAuth === "unknown" || refreshedAuth === undefined
              ? "Authentication command completed, but T3 Code could not verify the new state."
              : session.snapshot.action === "signIn"
                ? "Signed in successfully."
                : "Signed out successfully.";
    session.snapshot = {
      ...session.snapshot,
      status,
      exitCode,
      exitSignal,
      finishedAt,
      message,
      sequence: session.snapshot.sequence + 1,
    };
    session.unsubscribeData();
    session.unsubscribeExit();
    if (activeByInstance.get(session.snapshot.instanceId) === session.snapshot.sessionId) {
      activeByInstance.delete(session.snapshot.instanceId);
    }
    yield* providers.setProviderAuthSessionState({
      instanceId: session.snapshot.instanceId,
      activeSession: null,
    });
    yield* publish(session, {
      type: "settled",
      sessionId: session.snapshot.sessionId,
      sequence: session.snapshot.sequence,
      snapshot: session.snapshot,
    });
    yield* deleteSettledLater(session.snapshot.sessionId);
  });

  const forceKillLater = (session: Session) =>
    Effect.sleep(FORCE_KILL_DELAY).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (session.snapshot.status !== "running") return;
          try {
            session.process.kill("SIGKILL");
          } catch {
            // The process may have exited between the status check and signal.
          }
        }),
      ),
      Effect.forkIn(managerScope),
    );

  const cancelSession = Effect.fn("ProviderAuthSessionManager.cancelSession")(function* (
    session: Session,
  ) {
    if (session.snapshot.status !== "running") return;
    session.cancelled = true;
    yield* Effect.sync(() => {
      try {
        session.process.kill("SIGTERM");
      } catch {
        // Exit callback or forced cleanup will settle the session.
      }
    });
    yield* forceKillLater(session);
  });

  const cancelInvalidatedSessions = Effect.fn(
    "ProviderAuthSessionManager.cancelInvalidatedSessions",
  )(function* () {
    yield* Effect.forEach(
      sessions.values(),
      (session) =>
        instances
          .getInstance(session.snapshot.instanceId)
          .pipe(
            Effect.flatMap((current) =>
              current === session.instance ? Effect.void : cancelSession(session),
            ),
          ),
      { concurrency: "unbounded", discard: true },
    );
  });
  yield* Stream.runForEach(Stream.fromSubscription(instanceChanges), () =>
    cancelInvalidatedSessions(),
  ).pipe(Effect.forkIn(managerScope));

  const startUnlocked: ProviderAuthSessionManager["Service"]["start"] = Effect.fn(
    "ProviderAuthSessionManager.start",
  )(function* (input) {
    const activeId = activeByInstance.get(input.instanceId);
    if (activeId) {
      const active = sessions.get(activeId);
      if (active?.snapshot.action === input.action) return active.snapshot;
      return yield* makeError({
        reason: "session-conflict",
        message: `A provider authentication action is already running for '${input.instanceId}'.`,
        instanceId: input.instanceId,
        sessionId: activeId,
      });
    }

    const instance = yield* instances.getInstance(input.instanceId);
    if (!instance) {
      return yield* makeError({
        reason: "instance-not-found",
        message: `Unknown provider instance '${input.instanceId}'.`,
        instanceId: input.instanceId,
      });
    }
    const authentication = instance.authentication;
    if (!authentication) {
      return yield* makeError({
        reason: "unsupported",
        message: `Provider instance '${input.instanceId}' does not support in-app authentication.`,
        instanceId: input.instanceId,
      });
    }
    const provider = (yield* providers.getProviders).find(
      (candidate) => candidate.instanceId === input.instanceId,
    );
    if (provider && !provider.installed) {
      return yield* makeError({
        reason: "not-installed",
        message: `The CLI for '${input.instanceId}' is not installed.`,
        instanceId: input.instanceId,
      });
    }

    const launch = yield* authentication.resolveLaunch(input.action).pipe(
      Effect.mapError(() =>
        makeError({
          reason: "spawn-failed",
          message: `Could not prepare authentication for '${input.instanceId}'.`,
          instanceId: input.instanceId,
        }),
      ),
    );
    const resolved = yield* resolveSpawnCommand(launch.command, launch.args, {
      env: launch.env,
      extendEnv: true,
    });
    const command = resolved.shell
      ? (launch.env.ComSpec ?? process.env.ComSpec ?? "cmd.exe")
      : resolved.command;
    const args = resolved.shell
      ? ["/d", "/s", "/c", [resolved.command, ...resolved.args].join(" ")]
      : [...resolved.args];
    const sessionId = ProviderAuthSessionId.make(NodeCrypto.randomUUID());
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    const processResult = yield* pty
      .spawn({
        shell: command,
        args,
        cwd: launch.cwd,
        cols: input.cols ?? 100,
        rows: input.rows ?? 24,
        env: launch.env,
      })
      .pipe(Effect.result);
    if (processResult._tag === "Failure") {
      return yield* makeError({
        reason: "spawn-failed",
        message: `Could not start authentication for '${input.instanceId}'.`,
        instanceId: input.instanceId,
      });
    }

    const session: Session = {
      instance,
      process: processResult.success,
      listeners: new Set(),
      cancelled: false,
      unsubscribeData: () => {},
      unsubscribeExit: () => {},
      snapshot: {
        sessionId,
        instanceId: input.instanceId,
        action: input.action,
        status: "running",
        history: "",
        exitCode: null,
        exitSignal: null,
        startedAt,
        finishedAt: null,
        message: null,
        sequence: 0,
      },
    };
    sessions.set(sessionId, session);
    activeByInstance.set(input.instanceId, sessionId);
    session.unsubscribeData = session.process.onData((data) => {
      runFork(
        Effect.gen(function* () {
          if (session.snapshot.status !== "running") return;
          const outputData = data.slice(-MAX_HISTORY_LENGTH);
          const history = `${session.snapshot.history}${outputData}`.slice(-MAX_HISTORY_LENGTH);
          session.snapshot = {
            ...session.snapshot,
            history,
            sequence: session.snapshot.sequence + 1,
          };
          yield* publish(session, {
            type: "output",
            sessionId,
            sequence: session.snapshot.sequence,
            data: outputData,
          });
        }),
      );
    });
    session.unsubscribeExit = session.process.onExit((event) => {
      runFork(settle(session, event.exitCode, event.signal));
    });
    yield* providers.setProviderAuthSessionState({
      instanceId: input.instanceId,
      activeSession: { sessionId, action: input.action },
    });
    if (session.snapshot.status !== "running") {
      yield* providers.setProviderAuthSessionState({
        instanceId: input.instanceId,
        activeSession: null,
      });
    }
    yield* Effect.sleep(RUNNING_SESSION_TTL).pipe(
      Effect.tap(() => cancelSession(session)),
      Effect.forkIn(managerScope),
    );
    return session.snapshot;
  });
  const start: ProviderAuthSessionManager["Service"]["start"] = (input) => {
    const existing = startSemaphores.get(input.instanceId);
    const semaphore = existing ?? Semaphore.makeUnsafe(1);
    if (!existing) startSemaphores.set(input.instanceId, semaphore);
    return semaphore.withPermit(startUnlocked(input));
  };

  const lookup = (sessionId: ProviderAuthSessionId) => {
    const session = sessions.get(sessionId);
    return session
      ? Effect.succeed(session)
      : Effect.fail(
          makeError({
            reason: "session-not-found",
            message: "The provider authentication session no longer exists.",
            sessionId,
          }),
        );
  };

  const attachStream: ProviderAuthSessionManager["Service"]["attachStream"] = (input, listener) =>
    Effect.gen(function* () {
      const session = yield* lookup(input.sessionId);
      session.listeners.add(listener);
      yield* listener({ type: "snapshot", snapshot: session.snapshot }).pipe(
        Effect.onError(() => Effect.sync(() => session.listeners.delete(listener))),
      );
      return () => session.listeners.delete(listener);
    });

  const requireRunning = Effect.fn("ProviderAuthSessionManager.requireRunning")(function* (
    sessionId: ProviderAuthSessionId,
  ) {
    const session = yield* lookup(sessionId);
    if (session.snapshot.status !== "running") {
      return yield* makeError({
        reason: "session-not-running",
        message: "The provider authentication session is no longer running.",
        sessionId,
      });
    }
    return session;
  });

  const write: ProviderAuthSessionManager["Service"]["write"] = Effect.fn(
    "ProviderAuthSessionManager.write",
  )(function* (input) {
    const session = yield* requireRunning(input.sessionId);
    yield* Effect.try({
      try: () => session.process.write(input.data),
      catch: () =>
        makeError({
          reason: "session-not-running",
          message: "Could not write to the provider authentication session.",
          sessionId: input.sessionId,
        }),
    });
  });

  const resize: ProviderAuthSessionManager["Service"]["resize"] = Effect.fn(
    "ProviderAuthSessionManager.resize",
  )(function* (input) {
    const session = yield* requireRunning(input.sessionId);
    yield* Effect.try({
      try: () => session.process.resize(input.cols, input.rows),
      catch: () =>
        makeError({
          reason: "session-not-running",
          message: "Could not resize the provider authentication session.",
          sessionId: input.sessionId,
        }),
    });
  });

  const cancel: ProviderAuthSessionManager["Service"]["cancel"] = Effect.fn(
    "ProviderAuthSessionManager.cancel",
  )(function* (input) {
    const session = yield* requireRunning(input.sessionId);
    yield* cancelSession(session);
  });

  yield* Effect.addFinalizer(() =>
    Effect.forEach(sessions.values(), cancelSession, { concurrency: "unbounded", discard: true }),
  );

  return ProviderAuthSessionManager.of({ start, attachStream, write, resize, cancel });
});

export const layer = Layer.effect(ProviderAuthSessionManager, make());
