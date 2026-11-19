// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only host owns a Node child process.
// @effect-diagnostics globalTimers:off -- Deadlines run at child-process callback boundaries outside Effect fibers.

import * as NodeChildProcess from "node:child_process";

import {
  COMPUTER_LIMITS,
  type ComputerAct,
  type ComputerAction,
  type ComputerAnswers,
  type ComputerControl,
  type ComputerGrant,
  type ComputerHostEvent,
  type ComputerHostReply,
  type ComputerLimits,
  type ComputerLook,
  type ComputerObservation,
  type ComputerRect,
  type ComputerQuestion,
  type ComputerTaskOutcomeStatus,
} from "@t3tools/contracts";

/** A whole task, from its start to its end. The helper caps its own working time; this is the backstop. */
const TASK_DEADLINE_MS = 10 * 60_000;

/** The grants macOS attaches to the app that runs the helper, as the helper itself sees them. */
export type ComputerAccess = {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
  /** The app macOS attributes the grants to, which is this app because the child runs this binary. */
  readonly host: string;
};

/** One task's questions, grants and progress, answered by the environment's server through the renderer. */
export type ComputerHostAsk = {
  readonly authorize: (request: {
    readonly step: number;
    readonly observation: ComputerObservation;
    readonly action: ComputerAction;
  }) => Promise<ComputerGrant>;
  readonly decide: (input: {
    readonly state: unknown;
    readonly questions: Readonly<Record<string, ComputerQuestion>>;
  }) => Promise<ComputerAnswers>;
  readonly event: (event: ComputerHostEvent) => Promise<void>;
};

export type ComputerHostTask = {
  readonly environmentId: string;
  readonly requestId: string;
  readonly taskId: string;
  readonly goal: string;
  readonly text: string | null;
  readonly limits: ComputerLimits;
  readonly act?: ComputerAct;
  readonly ask: ComputerHostAsk;
};

export type ComputerHostLook = {
  readonly requestId: string;
  readonly app?: string;
  readonly screenshot: boolean;
  readonly region?: ComputerRect;
};

export type ComputerHostStartResult =
  | { readonly ok: true }
  /** Another task, from any environment, is running on this Mac. */
  | { readonly ok: false; readonly busy: true }
  | { readonly ok: false; readonly busy: false; readonly error: string };

export type ComputerHostProcess = {
  readonly alive: boolean;
  /** The task running or stopping on this Mac, if one is. */
  readonly task: { readonly environmentId: string; readonly taskId: string } | null;
  readonly access: () => Promise<ComputerAccess>;
  readonly start: (task: ComputerHostTask) => Promise<ComputerHostStartResult>;
  readonly control: (input: {
    readonly requestId: string;
    readonly control: ComputerControl;
  }) => Promise<ComputerHostReply>;
  readonly stop: (input: { readonly taskId: string; readonly reason: string }) => void;
  /** Reads a window; it runs beside a task, since it changes nothing. */
  readonly look: (input: ComputerHostLook) => Promise<ComputerHostReply>;
  /** Ends the running task, then the child. */
  readonly close: () => void;
};

/** The frames this host sends down to the helper, as far as it writes them. */
type ChildRequest =
  | {
      readonly id: string;
      readonly kind: "start";
      readonly task: {
        readonly goal: string;
        readonly text: string | null;
        readonly act?: ComputerAct;
      };
      readonly limits: { readonly maxSteps: number; readonly timeoutMs: number };
    }
  | {
      readonly id: string;
      readonly kind: "look";
      readonly app?: string;
      readonly screenshot: boolean;
      readonly region?: ComputerRect;
    }
  | { readonly id: string; readonly kind: "stop"; readonly taskId: string; readonly reason: string }
  | { readonly id: string; readonly kind: "control"; readonly control: ComputerControl }
  | { readonly id: string; readonly kind: "access" }
  | { readonly id: string; readonly kind: "answers"; readonly answers: ComputerAnswers }
  | { readonly id: string; readonly kind: "grant"; readonly grant: ComputerGrant };

/** An action the helper asks to take, in the helper's own words. */
type ChildAction =
  | { readonly kind: "click"; readonly ref: string; readonly role: string; readonly label: string }
  | {
      readonly kind: "type";
      readonly ref: string;
      readonly role: string;
      readonly label: string;
      readonly text: string;
    }
  | {
      readonly kind: "press";
      readonly key: string;
      readonly field?: { readonly role: string; readonly label: string };
    }
  | { readonly kind: "scroll"; readonly direction: string }
  | { readonly kind: "surface"; readonly what: string; readonly name: string }
  | { readonly kind: "open_url"; readonly url: string }
  | {
      readonly kind: "pointer";
      readonly step: string;
      readonly why: string;
      readonly target: { readonly role: string; readonly label: string } | null;
    };

/** The frames the helper sends up, as far as this host reads them. */
type ChildMessage =
  | { readonly id: string; readonly kind: "started"; readonly taskId: string }
  | { readonly id: string; readonly kind: "step"; readonly taskId: string; readonly text: string }
  | {
      readonly id: string;
      readonly kind: "finished";
      readonly taskId: string;
      readonly outcome: {
        readonly status: ComputerTaskOutcomeStatus;
        readonly reason: string;
        readonly steps: ReadonlyArray<string>;
        readonly surface: string | null;
      };
    }
  | {
      readonly id: string;
      readonly kind: "current";
      readonly current: { readonly id: string; readonly goal: string } | null;
    }
  | { readonly id: string; readonly kind: "access"; readonly access: ComputerAccess }
  | { readonly id: string; readonly kind: "control"; readonly done: string }
  | { readonly id: string; readonly kind: "look"; readonly look: ComputerLook }
  | {
      readonly id: string;
      readonly kind: "acted";
      readonly taskId: string;
      readonly action: string;
      readonly mode: "background" | "pointer";
      readonly how: string;
      readonly at?: { readonly x: number; readonly y: number };
    }
  | { readonly id: string; readonly kind: "error"; readonly error: string }
  | {
      readonly id: string;
      readonly kind: "decide";
      readonly taskId: string;
      readonly state: unknown;
      readonly questions: Readonly<Record<string, ComputerQuestion>>;
    }
  | {
      readonly id: string;
      readonly kind: "authorize";
      readonly taskId: string;
      readonly request: {
        readonly step: number;
        readonly observation: ComputerObservation;
        readonly action: ChildAction;
      };
    };

/** The helper's own words for an action, as the server's approval binds and judges it. */
const toComputerAction = (action: ChildAction): ComputerAction => {
  switch (action.kind) {
    case "click":
      return { kind: "click", ref: action.ref, role: action.role, label: action.label };
    case "type":
      return {
        kind: "type",
        ref: action.ref,
        role: action.role,
        label: action.label,
        text: action.text,
      };
    case "press":
      return {
        kind: "press",
        key: action.key,
        ...(action.field === undefined
          ? {}
          : { fieldRole: action.field.role, fieldLabel: action.field.label }),
      };
    case "scroll":
      return { kind: "scroll", direction: action.direction };
    case "surface":
      return { kind: "surface", what: action.what, name: action.name };
    case "open_url":
      return { kind: "open_url", url: action.url };
    case "pointer":
      return {
        kind: "pointer",
        why: action.why,
        ...(action.target === null ? {} : { role: action.target.role, label: action.target.label }),
      };
  }
};

/** The child half of the fork: what this host sends to, and hears from, one helper process. */
export interface ComputerHostChild {
  send(message: string, callback?: (error: Error | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): unknown;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type ComputerHostProcessOptions = {
  /** The bundled helper entry, forked as the app's own binary in Node mode. */
  readonly workerPath: string;
  /** How long a start, control or access request may go unanswered before the child is replaced. */
  readonly replyTimeoutMs?: number;
  /** How long a task may run before the child is stopped, whatever it reports. */
  readonly taskTimeoutMs?: number;
  readonly fork?: (workerPath: string) => ComputerHostChild;
  /** The child ended for a reason of its own: the host has no helper until the next request forks one. */
  readonly onExit?: (reason: string) => void;
  /** Where the helper just acted, for the overlay. */
  readonly onActed?: (spot: {
    readonly x: number;
    readonly y: number;
    readonly mode: "background" | "pointer";
  }) => void;
  readonly log?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Fork the helper as this app's own executable in Node mode. Electron's Helper binary lacks the app's
 * Accessibility grant, so the child must be `process.execPath` rather than `utilityProcess`.
 */
const forkComputerHost = (workerPath: string): ComputerHostChild =>
  NodeChildProcess.fork(workerPath, [], {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    execArgv: [],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });

type Pending = {
  readonly resolve: (message: ChildMessage) => void;
  readonly reject: (error: Error) => void;
  readonly deadline: ReturnType<typeof setTimeout>;
};

type ActiveTask = ComputerHostTask & {
  readonly deadline: ReturnType<typeof setTimeout>;
  /** Told to stop: held until the helper reports its end, and granted nothing meanwhile. */
  readonly stopping: boolean;
};

const STOPPED = "It was stopped.";

/**
 * The computer-use helper as this app runs it: one forked child, one task at a time, and a deadline on
 * anything that stops answering. Nothing here talks to an environment; it runs what it is told to.
 */
export function startComputerHostProcess(options: ComputerHostProcessOptions): ComputerHostProcess {
  const replyTimeoutMs = options.replyTimeoutMs ?? COMPUTER_LIMITS.replyTimeoutMs;
  const taskTimeoutMs = options.taskTimeoutMs ?? TASK_DEADLINE_MS;
  const log = options.log ?? (() => undefined);
  const fork = options.fork ?? forkComputerHost;
  const pending = new Map<string, Pending>();
  let child: ComputerHostChild | null = null;
  let task: ActiveTask | null = null;
  let closed = false;
  let requests = 0;

  const clearTask = () => {
    if (task === null) return;
    clearTimeout(task.deadline);
    task = null;
  };

  const settle = (id: string): Pending | null => {
    const entry = pending.get(id);
    if (entry === undefined) return null;
    pending.delete(id);
    clearTimeout(entry.deadline);
    return entry;
  };

  const kill = (reason: string, notify = true) => {
    const running = task;
    clearTask();
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.deadline);
      entry.reject(new Error(reason));
    }
    const dying = child;
    child = null;
    if (running !== null) {
      void running.ask
        .event({ type: "finished", status: "failed", reason, steps: [], surface: null })
        .catch((error: unknown) =>
          log("computer_host.finished_failed", { error: messageOf(error) }),
        );
    }
    if (dying === null) return;
    try {
      dying.kill();
    } catch (error) {
      log("computer_host.kill_failed", { error: messageOf(error) });
    }
    if (notify) options.onExit?.(reason);
  };

  const write = (request: ChildRequest): boolean => {
    if (closed) return false;
    if (child === null) {
      try {
        const forked = fork(options.workerPath);
        forked.on("message", (message: unknown) => {
          if (child === forked) receive(message);
        });
        // A replaced child's death is not this host's: only the current process ends it.
        forked.on("exit", () => {
          if (child === forked) kill("The computer helper stopped.");
        });
        forked.on("error", (error: Error) => {
          if (child === forked) kill(`The computer helper stopped: ${messageOf(error)}`);
        });
        child = forked;
      } catch (error) {
        log("computer_host.fork_failed", { error: messageOf(error) });
        return false;
      }
    }
    try {
      child.send(`${JSON.stringify(request)}\n`);
      return true;
    } catch (error) {
      log("computer_host.send_failed", { kind: request.kind, error: messageOf(error) });
      kill("The computer helper stopped.");
      return false;
    }
  };

  const request = <T extends ChildMessage>(frame: ChildRequest, timeoutMs = replyTimeoutMs) => {
    const settled = new Promise<T>((resolve, reject) => {
      const deadline = setTimeout(() => {
        pending.delete(frame.id);
        log("computer_host.deadline", { kind: frame.kind });
        const reason =
          frame.kind === "start"
            ? "The computer helper did not answer, so the task did not start."
            : "The computer helper did not answer.";
        kill(reason);
        reject(new Error(reason));
      }, timeoutMs);
      deadline.unref?.();
      pending.set(frame.id, {
        resolve: resolve as (message: ChildMessage) => void,
        reject,
        deadline,
      });
    });
    if (!write(frame)) {
      const entry = settle(frame.id);
      entry?.reject(new Error("The computer helper is not running."));
    }
    return settled;
  };

  const refuse = (
    message: Extract<ChildMessage, { kind: "decide" | "authorize" }>,
    denied: string,
  ) =>
    write(
      message.kind === "decide"
        ? { id: message.id, kind: "answers", answers: {} }
        : { id: message.id, kind: "grant", grant: { ok: false, denied } },
    );

  /** A grant that comes back after its task was told to stop is refused, whatever the environment said. */
  const late = (taskId: string) => task === null || task.taskId !== taskId || task.stopping;

  const answer = (message: Extract<ChildMessage, { kind: "decide" | "authorize" }>) => {
    const running = task === null || task.taskId !== message.taskId ? null : task;
    if (running?.stopping === true) {
      refuse(message, STOPPED);
      return;
    }
    if (running === null) {
      // The step outlived its task, so nothing waits for this answer: end the helper's step.
      write(
        message.kind === "decide"
          ? { id: message.id, kind: "answers", answers: {} }
          : {
              id: message.id,
              kind: "grant",
              grant: {
                ok: false,
                denied:
                  "Ada lost track of this task, so the step was not done. This is an internal error, not a denial.",
              },
            },
      );
      return;
    }
    const answered =
      message.kind === "decide"
        ? running.ask
            .decide({ state: message.state, questions: message.questions })
            .then((answers) => ({ id: message.id, kind: "answers" as const, answers }))
        : running.ask
            .authorize({
              step: message.request.step,
              observation: message.request.observation,
              action: toComputerAction(message.request.action),
            })
            .then((grant) => ({ id: message.id, kind: "grant" as const, grant }));
    void answered
      .then(
        (frame) =>
          frame.kind === "grant" && frame.grant.ok && late(message.taskId)
            ? refuse(message, STOPPED)
            : write(frame),
        (error: unknown) =>
          write(
            message.kind === "decide"
              ? { id: message.id, kind: "answers", answers: {} }
              : { id: message.id, kind: "grant", grant: { ok: false, denied: messageOf(error) } },
          ),
      )
      .catch((error: unknown) => log("computer_host.answer_failed", { error: messageOf(error) }));
  };

  const receive = (raw: unknown) => {
    if (typeof raw !== "string") {
      log("computer_host.unreadable_frame");
      return;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let message: ChildMessage;
      try {
        message = JSON.parse(line) as ChildMessage;
      } catch {
        log("computer_host.unreadable_frame");
        continue;
      }
      switch (message.kind) {
        case "step": {
          const running = task === null || task.taskId !== message.taskId ? null : task;
          if (running === null) break;
          void running.ask
            .event({ type: "step", text: message.text })
            .catch((error: unknown) =>
              log("computer_host.step_failed", { error: messageOf(error) }),
            );
          break;
        }
        case "finished": {
          const running = task === null || task.taskId !== message.taskId ? null : task;
          if (running !== null) {
            clearTask();
            void running.ask
              .event({
                type: "finished",
                status: message.outcome.status,
                reason: message.outcome.reason,
                steps: [...message.outcome.steps],
                surface: message.outcome.surface,
              })
              .catch((error: unknown) =>
                log("computer_host.finished_failed", { error: messageOf(error) }),
              );
          }
          settle(message.id)?.resolve(message);
          break;
        }
        case "acted": {
          if (message.at !== undefined) options.onActed?.({ ...message.at, mode: message.mode });
          const running = task === null || task.taskId !== message.taskId ? null : task;
          if (running === null) break;
          void running.ask
            .event({ type: "acted", kind: message.action, mode: message.mode, how: message.how })
            .catch((error: unknown) =>
              log("computer_host.acted_failed", { error: messageOf(error) }),
            );
          break;
        }
        case "started":
        case "current":
        case "control":
        case "access":
        case "look":
          settle(message.id)?.resolve(message);
          break;
        case "error": {
          const entry = settle(message.id);
          if (entry !== null) entry.reject(new Error(message.error));
          else log("computer_host.error", { error: message.error });
          break;
        }
        case "decide":
        case "authorize":
          answer(message);
          break;
      }
    }
  };

  return {
    get alive() {
      return !closed && child !== null;
    },
    get task() {
      return task === null ? null : { environmentId: task.environmentId, taskId: task.taskId };
    },
    access: () =>
      request<Extract<ChildMessage, { kind: "access" }>>({
        id: `computerd_${++requests}`,
        kind: "access",
      }).then((message) => message.access),
    start: async (next) => {
      if (closed) return { ok: false, busy: false, error: "This computer's helper is stopped." };
      if (task !== null) return { ok: false, busy: true };
      const deadline = setTimeout(() => {
        log("computer_host.task_deadline", { taskId: next.taskId });
        kill("The task ran past its time.");
      }, taskTimeoutMs);
      deadline.unref?.();
      // Held from the request on, so a second start racing this one is busy, not sent to the helper.
      task = { ...next, deadline, stopping: false };
      const started = await request<Extract<ChildMessage, { kind: "started" }>>(
        {
          id: next.taskId,
          kind: "start",
          task: {
            goal: next.goal,
            text: next.text,
            ...(next.act === undefined ? {} : { act: next.act }),
          },
          limits: { maxSteps: next.limits.maxSteps, timeoutMs: next.limits.timeoutMs },
        },
        replyTimeoutMs,
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, busy: false as const, error: messageOf(error) }),
      );
      if (!started.ok) {
        if (task?.taskId === next.taskId) clearTask();
        else clearTimeout(deadline);
        return started;
      }
      return { ok: true };
    },
    control: async (input) => {
      if (task !== null) {
        return {
          requestId: input.requestId,
          ok: false,
          error: "This computer is busy with a task.",
        };
      }
      return await request<Extract<ChildMessage, { kind: "control" }>>({
        id: input.requestId,
        kind: "control",
        control: input.control,
      }).then(
        (message) => ({ requestId: input.requestId, ok: true as const, done: message.done }),
        (error: unknown) => ({
          requestId: input.requestId,
          ok: false as const,
          error: messageOf(error),
        }),
      );
    },
    look: (input) =>
      request<Extract<ChildMessage, { kind: "look" }>>({
        id: input.requestId,
        kind: "look",
        screenshot: input.screenshot,
        ...(input.app === undefined ? {} : { app: input.app }),
        ...(input.region === undefined ? {} : { region: input.region }),
      }).then(
        (message) => ({ requestId: input.requestId, ok: true as const, look: message.look }),
        (error: unknown) => ({
          requestId: input.requestId,
          ok: false as const,
          error: messageOf(error),
        }),
      ),
    stop: (input) => {
      // The task stays until the helper reports its end, which is what frees the computer for the server.
      if (task?.taskId === input.taskId && !task.stopping) {
        clearTimeout(task.deadline);
        const deadline = setTimeout(() => {
          log("computer_host.stop_deadline", { taskId: input.taskId });
          kill("The computer helper did not stop.");
        }, replyTimeoutMs);
        deadline.unref?.();
        task = { ...task, deadline, stopping: true };
      }
      write({
        id: `stop_${input.taskId}`,
        kind: "stop",
        taskId: input.taskId,
        reason: input.reason,
      });
    },
    close: () => {
      if (closed) return;
      kill("You stopped it.", false);
      closed = true;
    },
  };
}
