// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only host owns a Node child process.
// @effect-diagnostics globalTimers:off -- Calls the helper waits on are answered at child-process boundaries.

import {
  COMPUTER_CONTROL_KINDS,
  COMPUTER_LIMITS,
  type ComputerHostFrame,
  type ComputerHostReply,
  type ComputerGrant,
  type ComputerHostAccess,
  type ComputerAnswers,
  type ComputerObservation,
  type ComputerAction,
  type ComputerHostEvent,
  type DesktopComputerAnswer,
  type DesktopComputerCall,
  type DesktopComputerOffer,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  type ComputerAccess,
  type ComputerHostProcess,
  startComputerHostProcess,
  type ComputerHostTask,
} from "./ComputerHostProcess.ts";

/** A call's answer needs no more than one tap, the planner, and one reply. */
const CALL_TIMEOUT_MS =
  COMPUTER_LIMITS.approvalTimeoutMs +
  COMPUTER_LIMITS.plannerTimeoutMs +
  COMPUTER_LIMITS.replyTimeoutMs;

type ActiveTask = { readonly environmentId: EnvironmentId; readonly taskId: string };

type PendingCall = {
  readonly environmentId: EnvironmentId;
  readonly settle: (answer: DesktopComputerAnswer) => void;
  readonly deadline: ReturnType<typeof setTimeout>;
};

const NOT_MACOS = "Computer use runs on macOS in this version.";
const NO_HELPER = "The computer helper is not running.";
const OTHER_ENVIRONMENT = "This computer is busy with a task another environment started.";
/** The local stop: it ends the task on this Mac without asking the environment, so it works offline. */
const STOP_SHORTCUT = "CommandOrControl+Shift+Escape";
const STOPPED_HERE = "You stopped it on this computer.";
const NO_ACCESSIBILITY =
  "This computer cannot read its screen: allow Ada in System Settings › Privacy & Security › Accessibility.";

const toHostAccess = (access: ComputerAccess): ComputerHostAccess => ({
  computerUse: access.accessibility,
  accessibility: access.accessibility,
  screenRecording: access.screenRecording,
});

/**
 * The computer use host this desktop offers to one environment at a time. It owns the helper child, the
 * one task the helper runs, and the calls that task needs answered; an environment sees only frames.
 */
export class DesktopComputerHost extends Context.Service<
  DesktopComputerHost,
  {
    /** This Mac as a host for one environment, or the sentence that says why it cannot be one. */
    readonly prepare: (environmentId: EnvironmentId) => Effect.Effect<DesktopComputerOffer>;
    /** One frame from the environment's server; a reply when the frame asks for one. */
    readonly frame: (
      environmentId: EnvironmentId,
      frame: ComputerHostFrame,
    ) => Effect.Effect<ComputerHostReply | null>;
    /** The environment's host stream ended: end what it was running on this Mac. */
    readonly disconnect: (environmentId: EnvironmentId) => Effect.Effect<void>;
    /** Answers a call the helper made while it worked. */
    readonly answer: (answer: DesktopComputerAnswer) => Effect.Effect<void>;
    /** Calls the helper makes while hosting: grants, questions, steps, and its end. */
    readonly calls: Stream.Stream<DesktopComputerCall>;
  }
>()("@t3tools/desktop/computer/DesktopComputerHost") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const hostname = yield* HostProcess.Hostname;
  const calls = yield* PubSub.unbounded<DesktopComputerCall>();
  const workerPath = environment.path.join(
    environment.dirname,
    "computer",
    "ComputerHostWorker.cjs",
  );

  const hosted = new Set<EnvironmentId>();
  const pending = new Map<string, PendingCall>();
  let helper: ComputerHostProcess | null = null;
  let running: ActiveTask | null = null;
  let callCounter = 0;
  /** The grants the environments last heard, so a grant made after connecting reaches them. */
  let reported: ComputerHostAccess | null = null;

  const failCalls = (environmentId: EnvironmentId | null, message: string) => {
    for (const [callId, call] of pending) {
      if (environmentId !== null && call.environmentId !== environmentId) continue;
      pending.delete(callId);
      clearTimeout(call.deadline);
      call.settle({ type: "failed", callId, message });
    }
  };

  const releaseStopShortcut = () => {
    try {
      Electron.globalShortcut.unregister(STOP_SHORTCUT);
    } catch {
      // A shortcut the platform refused to register is already absent.
    }
  };

  const holdStopShortcut = () => {
    if (environment.platform !== "darwin") return;
    try {
      Electron.globalShortcut.register(STOP_SHORTCUT, stopLocally);
    } catch {
      // Nothing to unregister when the system would not take the chord.
    }
  };

  const dropHelper = () => {
    releaseStopShortcut();
    helper?.close();
    helper = null;
    running = null;
    reported = null;
  };

  const ensureHelper = (): ComputerHostProcess => {
    if (helper !== null) return helper;
    const started = startComputerHostProcess({
      workerPath,
      onExit: (reason) => {
        if (helper !== started) return;
        helper = null;
        running = null;
        releaseStopShortcut();
        failCalls(null, reason);
        for (const environmentId of hosted) {
          void PubSub.publishUnsafe(calls, {
            type: "closed",
            callId: `closed_${++callCounter}`,
            environmentId,
            reason,
          });
        }
      },
    });
    helper = started;
    return started;
  };

  /**
   * One call the helper waits on. The environment answers over the renderer's connection; an answer that
   * never comes fails the step instead of leaving the helper's run hanging.
   */
  const ask = <A>(
    call: (callId: string) => DesktopComputerCall,
    settleAnswer: (answer: DesktopComputerAnswer, callId: string) => A,
  ): Promise<A> =>
    new Promise<A>((settle) => {
      const callId = `call_${++callCounter}`;
      const deadline = setTimeout(() => {
        pending.delete(callId);
        settle(
          settleAnswer(
            { type: "failed", callId, message: "The environment did not answer." },
            callId,
          ),
        );
      }, CALL_TIMEOUT_MS);
      deadline.unref?.();
      const request = call(callId);
      pending.set(callId, {
        environmentId: request.environmentId,
        settle: (answer) => settle(settleAnswer(answer, callId)),
        deadline,
      });
      void PubSub.publishUnsafe(calls, request);
    });

  /** Reads the grants again and tells every hosted environment when they changed since it last heard. */
  const refreshAccess = async (host: ComputerHostProcess): Promise<ComputerHostAccess | null> => {
    const access = await host.access().then(toHostAccess, () => null);
    if (access === null || helper !== host) return access;
    const changed =
      reported !== null &&
      (reported.accessibility !== access.accessibility ||
        reported.screenRecording !== access.screenRecording);
    reported = access;
    if (!changed) return access;
    for (const environmentId of hosted) {
      void ask<void>(
        (callId) => ({ type: "access", callId, environmentId, access }),
        () => undefined,
      );
    }
    return access;
  };

  // Grants are made in System Settings, so coming back to the app is when one may have changed.
  const onWindowFocus = () => {
    if (helper !== null && hosted.size > 0) void refreshAccess(helper);
  };
  Electron.app.on("browser-window-focus", onWindowFocus);

  /**
   * Ends the task on this Mac first, so it works with the network down, then tells the environment:
   * the helper's own end is dropped once its task is cleared.
   */
  const stopLocally = () => {
    const task = running;
    if (task === null) return;
    running = null;
    releaseStopShortcut();
    helper?.stop({ taskId: task.taskId, reason: STOPPED_HERE });
    void ask<void>(
      (callId) => ({
        type: "event",
        callId,
        environmentId: task.environmentId,
        taskId: task.taskId,
        event: {
          type: "finished",
          status: "stopped",
          reason: STOPPED_HERE,
          steps: [],
          surface: null,
        },
      }),
      () => undefined,
    );
  };

  const askAuthorize = (
    owner: { readonly environmentId: EnvironmentId; readonly taskId: string },
    request: {
      readonly step: number;
      readonly observation: ComputerObservation;
      readonly action: ComputerAction;
    },
  ) =>
    ask<ComputerGrant>(
      (callId) => ({
        type: "authorize",
        callId,
        environmentId: owner.environmentId,
        taskId: owner.taskId,
        ...request,
      }),
      (answer) =>
        answer.type === "grant"
          ? answer.grant
          : {
              ok: false,
              denied:
                answer.type === "failed" ? answer.message : "The environment did not allow it.",
            },
    );

  const taskAsk = (owner: {
    readonly environmentId: EnvironmentId;
    readonly taskId: string;
  }): ComputerHostTask["ask"] => ({
    authorize: (request) => askAuthorize(owner, request),
    decide: ({ state, questions }) =>
      ask<ComputerAnswers>(
        (callId) => ({
          type: "decide",
          callId,
          environmentId: owner.environmentId,
          taskId: owner.taskId,
          state,
          questions,
        }),
        (answer) => (answer.type === "answers" ? answer.answers : {}),
      ),
    event: async (event: ComputerHostEvent) => {
      if (event.type === "step" && running?.taskId !== owner.taskId) return;
      if (event.type === "finished") {
        // A task the server already stopped, or one whose stop came from this Mac, has no listener left.
        if (running?.taskId !== owner.taskId) return;
        running = null;
        releaseStopShortcut();
      }
      await ask<void>(
        (callId) => ({
          type: "event",
          callId,
          environmentId: owner.environmentId,
          taskId: owner.taskId,
          event,
        }),
        () => undefined,
      );
    },
  });

  const prepare = Effect.fn("DesktopComputerHost.prepare")(function* (
    environmentId: EnvironmentId,
  ) {
    if (environment.platform !== "darwin") {
      return { ok: false as const, reason: NOT_MACOS, retry: "never" as const };
    }
    if (running !== null && running.environmentId !== environmentId) {
      return { ok: false as const, reason: OTHER_ENVIRONMENT, retry: "wait" as const };
    }
    const host = ensureHelper();
    const access = yield* Effect.tryPromise({
      try: () => host.access().then(toHostAccess),
      catch: () => "unavailable" as const,
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          dropHelper();
          return null;
        }),
      ),
    );
    if (access === null) {
      return {
        ok: false as const,
        reason:
          "The computer helper did not start. Grant the permission it asks for and try again.",
        retry: "wait" as const,
      };
    }
    reported = access;
    return {
      ok: true as const,
      hello: {
        name: hostname,
        device: hostname,
        platform: environment.platform,
        version: environment.appVersion,
        controls: [...COMPUTER_CONTROL_KINDS],
        ...access,
      },
    };
  });

  const control = (
    environmentId: EnvironmentId,
    frame: Extract<ComputerHostFrame, { kind: "control" }>,
  ): Promise<ComputerHostReply> => {
    const host = helper;
    if (host === null) {
      return Promise.resolve({ requestId: frame.requestId, ok: false, error: NO_HELPER });
    }
    if (running !== null && running.environmentId !== environmentId) {
      return Promise.resolve({ requestId: frame.requestId, ok: false, error: OTHER_ENVIRONMENT });
    }
    return host.control({ requestId: frame.requestId, control: frame.control });
  };

  const start = async (
    environmentId: EnvironmentId,
    frame: Extract<ComputerHostFrame, { kind: "start" }>,
  ): Promise<ComputerHostReply> => {
    const host = helper;
    if (host === null) return { requestId: frame.requestId, ok: false, error: NO_HELPER };
    if (running !== null && running.environmentId !== environmentId) {
      return { requestId: frame.requestId, ok: false, error: OTHER_ENVIRONMENT };
    }
    const access = await refreshAccess(host);
    if (access !== null && !access.accessibility) {
      return { requestId: frame.requestId, ok: false, error: NO_ACCESSIBILITY };
    }
    const task: ComputerHostTask = {
      environmentId,
      requestId: frame.requestId,
      taskId: frame.taskId,
      goal: frame.goal,
      text: frame.text,
      limits: frame.limits,
      ask: taskAsk({ environmentId, taskId: frame.taskId }),
    };
    const started = await host.start(task);
    if (started.ok) {
      running = { environmentId, taskId: frame.taskId };
      holdStopShortcut();
      return { requestId: frame.requestId, ok: true };
    }
    return {
      requestId: frame.requestId,
      ok: false,
      error: started.busy ? "This computer is busy with another task." : started.error,
    };
  };

  const frame = Effect.fn("DesktopComputerHost.frame")(function* (
    environmentId: EnvironmentId,
    next: ComputerHostFrame,
  ) {
    switch (next.kind) {
      case "welcome":
        hosted.add(environmentId);
        return null;
      case "stop": {
        if (running?.environmentId === environmentId) {
          running = null;
          releaseStopShortcut();
        }
        helper?.stop({ taskId: next.taskId, reason: next.reason });
        return null;
      }
      case "control":
        return yield* Effect.promise(() => control(environmentId, next));
      case "start":
        return yield* Effect.promise(() => start(environmentId, next));
    }
  });

  const disconnect = (environmentId: EnvironmentId) =>
    Effect.sync(() => {
      hosted.delete(environmentId);
      if (running?.environmentId === environmentId) {
        const taskId = running.taskId;
        running = null;
        releaseStopShortcut();
        helper?.stop({
          taskId,
          reason: "The environment stopped using this computer.",
        });
      }
      failCalls(environmentId, "The environment stopped using this computer.");
      if (hosted.size === 0) dropHelper();
    });

  const answer = (received: DesktopComputerAnswer) =>
    Effect.sync(() => {
      const call = pending.get(received.callId);
      if (call === undefined) return;
      pending.delete(received.callId);
      clearTimeout(call.deadline);
      call.settle(received);
    });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      Electron.app.off("browser-window-focus", onWindowFocus);
      dropHelper();
    }),
  );

  return DesktopComputerHost.of({
    prepare,
    frame,
    disconnect,
    answer,
    calls: Stream.fromPubSub(calls),
  });
});

export const layer = Layer.effect(DesktopComputerHost, make);
