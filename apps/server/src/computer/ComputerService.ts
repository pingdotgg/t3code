// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, src/computer/hub.zig and
// src/computer/gate.zig), Apache-2.0, Copyright 2026 Jay Leaton. Modified for Ada: Effect services and
// Ada's RPC in place of a locked hub and a socket protocol, plan steps answered by an agent or a
// configured grounder, and a setting that grants consequential steps without a tap.
import type {
  ComputerAct,
  ComputerAnswers,
  ComputerApprovalBinding,
  ComputerApprovalId,
  ComputerApprovalsMode,
  ComputerControl,
  ComputerControlKind,
  ComputerDecision,
  ComputerGrant,
  ComputerHostAccess,
  ComputerHostConnectInput,
  ComputerHostEvent,
  ComputerHostFrame,
  ComputerHostId,
  ComputerHostReply,
  ComputerHostView,
  ComputerLook,
  ComputerObservation,
  ComputerRect,
  ComputerPlannerAnswers,
  ComputerQuestions,
  ComputerSnapshot,
  ComputerTaskId,
  ComputerTaskKind,
  ComputerTaskStatus,
  ComputerTaskView,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { COMPUTER_LIMITS, ComputerError } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerApprovals from "./ComputerApprovals.ts";
import {
  actionAuditFields,
  APPROVAL_REQUEST_AUDIT_EVENT,
  APPROVAL_SKIPPED_AUDIT_EVENT,
  approvalAuditFields,
  clip,
  textDigest,
} from "./ComputerAudit.ts";
import * as ComputerAudit from "./ComputerAudit.ts";
import { afterJudge, control as controlPolicy, screen } from "./ComputerPolicy.ts";
import * as ComputerDecider from "./ComputerDecider.ts";

/**
 * The computer-use capability: the hosts a person connected, one task on each, its budgets, and the
 * authority over every step. A host asks before each action and acts only on a grant. A task never
 * outlives its thread's run: Stop, an interrupt, a host disconnect and the local stop all end it.
 */

/** Time a whole task may spend, waits included: a planner wait is capped separately. */
const WALL_TIME_MS = 10 * 60_000;
/** A planner's turn at the questions, inside the wall clock. */
const PLANNER_TIMEOUT = Duration.millis(COMPUTER_LIMITS.plannerTimeoutMs);
const APPROVAL_TIMEOUT = Duration.millis(COMPUTER_LIMITS.approvalTimeoutMs);
const REPLY_TIMEOUT = Duration.millis(COMPUTER_LIMITS.replyTimeoutMs);
const MAX_GOAL = 1_000;
const MAX_TEXT = 4_000;
const MAX_STEP_TEXT = 200;
/** The visible text the grounder reads of one screen. */
const MAX_SCREEN_TEXT = 1_500;
const TYPED_TEXT = "[typed text]";
/** Ended tasks kept for the strip and the tools; every snapshot carries them. */
const MAX_ENDED_TASKS = 10;

type PendingDecision = {
  readonly id: string;
  readonly questions: ComputerQuestions;
  readonly wake: Deferred.Deferred<ComputerAnswers, ComputerError>;
};

type Task = {
  readonly id: ComputerTaskId;
  readonly kind: ComputerTaskKind;
  readonly hostId: ComputerHostId;
  readonly hostName: string;
  readonly goal: string;
  /** The only text a task may type. Never copied into a view, an audit line or an error. */
  readonly text: string | null;
  readonly requester: string;
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
  readonly startedAtMs: number;
  readonly status: ComputerTaskStatus;
  readonly reason: string;
  readonly surface: string;
  readonly steps: ReadonlyArray<string>;
  readonly endedAtMs: number | null;
  /** Waiting for a tap or the planner: working time does not include it. */
  readonly waitedMs: number;
  readonly authorized: number;
  readonly decided: number;
  readonly approvalId: ComputerApprovalId | null;
  readonly decision: PendingDecision | null;
  /** A grounder that failed once hands this task's clicks to the tap instead of asking again. */
  readonly grounderFailed: boolean;
  readonly approvalsMode: ComputerApprovalsMode;
  /** The screen's visible text at the last decision, cleared by the next step. Empty when unknown. */
  readonly screenText: string;
};

type Host = {
  readonly id: ComputerHostId;
  readonly name: string;
  readonly device: string;
  readonly platform: string;
  readonly version: string;
  readonly controls: ReadonlyArray<ComputerControlKind>;
  readonly computerUse: boolean;
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
  readonly connectedAtMs: number;
  readonly taskId: ComputerTaskId | null;
  readonly send: (frame: ComputerHostFrame) => void;
  /** Ends the host's stream, so its session closes as if the computer went away. */
  readonly end: () => Effect.Effect<void>;
};

type PendingReply = {
  readonly hostId: ComputerHostId;
  readonly reply: Deferred.Deferred<ComputerHostReply, ComputerError>;
};

type ApprovalWake = "answered" | "cancelled" | "timeout";

type PendingApproval = {
  readonly taskId: ComputerTaskId;
  readonly wake: Deferred.Deferred<ApprovalWake>;
};

interface ServiceState {
  readonly hosts: ReadonlyArray<Host>;
  readonly tasks: ReadonlyArray<Task>;
  readonly approvals: ReadonlyMap<ComputerApprovalId, PendingApproval>;
  readonly replies: ReadonlyMap<string, PendingReply>;
}

const EMPTY: ServiceState = {
  hosts: [],
  tasks: [],
  approvals: new Map(),
  replies: new Map(),
};

const replaceTask = (state: ServiceState, task: Task): ServiceState => ({
  ...state,
  tasks: state.tasks.map((candidate) => (candidate.id === task.id ? task : candidate)),
});

const withoutOldEnded = (tasks: ReadonlyArray<Task>): ReadonlyArray<Task> => {
  let ended = tasks.filter((task) => task.status !== "running").length;
  if (ended <= MAX_ENDED_TASKS) return tasks;
  return tasks.filter((task) => task.status === "running" || ended-- <= MAX_ENDED_TASKS);
};

const patchTask = (
  state: ServiceState,
  taskId: ComputerTaskId,
  patch: (task: Task) => Task,
): ServiceState => {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  return task === undefined ? state : replaceTask(state, patch(task));
};

const hostView = (host: Host): ComputerHostView => ({
  hostId: host.id,
  name: host.name,
  device: host.device,
  platform: host.platform,
  version: host.version,
  controls: [...host.controls],
  computerUse: host.computerUse,
  accessibility: host.accessibility,
  screenRecording: host.screenRecording,
  busyTaskId: host.taskId,
  connectedAt: DateTime.makeUnsafe(host.connectedAtMs),
});

/** Only the agent's tools read the planner's questions, so client snapshots leave them out. */
const taskView = (task: Task, withQuestions = true): ComputerTaskView => ({
  taskId: task.id,
  kind: task.kind,
  hostId: task.hostId,
  hostName: task.hostName,
  goal: task.goal,
  status: task.status,
  reason: task.reason,
  surface: task.surface,
  steps: [...task.steps],
  requester: task.requester,
  threadId: task.threadId,
  startedAt: DateTime.makeUnsafe(task.startedAtMs),
  endedAt: task.endedAtMs === null ? null : DateTime.makeUnsafe(task.endedAtMs),
  waitingForApproval: task.approvalId,
  pendingDecision:
    task.decision === null
      ? null
      : withQuestions
        ? { id: task.decision.id, questions: task.decision.questions }
        : { id: task.decision.id },
  approvalsMode: task.approvalsMode,
  ...(withQuestions && task.screenText !== "" ? { screenText: task.screenText } : {}),
});

const DecidedScreen = Schema.Struct({ screen: Schema.Struct({ visibleText: Schema.String }) });
const decodeDecidedScreen = Schema.decodeUnknownOption(DecidedScreen);

/** The visible text a host decided on, capped, with the task's typed text hidden as the helper hides it. */
function screenTextOf(state: unknown, typed: string | null): string {
  const text = Option.match(decodeDecidedScreen(state), {
    onNone: () => "",
    onSome: (decided) => decided.screen.visibleText,
  });
  const hidden = typed !== null && typed.length >= 3 ? text.split(typed).join(TYPED_TEXT) : text;
  return hidden.slice(0, MAX_SCREEN_TEXT);
}

/** A control in words for the card and the log ("open Safari", "volume down"). */
function describeControl(control: ComputerControl): string {
  switch (control.kind) {
    case "open_app":
      return `open ${control.app ?? "an app"}`;
    case "quit_app":
      return `quit ${control.app ?? "an app"}`;
    case "volume":
      return `volume ${control.action ?? "change"}`;
    case "media":
      return `${control.action ?? "media"} on ${control.player ?? "the player"}`;
    case "dark_mode":
      return `dark mode ${control.action ?? "toggle"}`;
    case "lock_screen":
      return "lock the screen";
  }
}

/** An agent's own step in words for the strip and the log; the text it types is never part of it. */
function describeAct(act: ComputerAct, typed: string | null): string {
  switch (act.action) {
    case "click":
      return act.label
        ? `click “${clip(act.label)}”`
        : act.ref
          ? `click ${act.ref}`
          : `click at ${act.x ?? 0},${act.y ?? 0}`;
    case "type":
      return `type ${typed === null ? 0 : Array.from(typed).length} characters`;
    case "key":
      return `press ${act.key ?? "a key"}`;
    case "scroll":
      return `scroll ${act.direction ?? "down"}`;
    case "open_url":
      return `open ${clip(act.url ?? "a page")}`;
  }
}

const failure = (
  reason: ComputerError["reason"],
  detail: string,
  extra: { readonly taskId?: string; readonly hostId?: string } = {},
) => new ComputerError({ reason, detail, ...extra });

const NO_COMPUTER =
  "No computer is connected to this environment. Open Ada on the computer you want to use and allow this environment in Settings → Computer use.";

export class ComputerService extends Context.Service<
  ComputerService,
  {
    /** An agent's fixed control: run it, asking a person first only when the policy says so. */
    readonly control: (input: {
      readonly control: ComputerControl;
      readonly hostId?: ComputerHostId;
      readonly requester: string;
      readonly threadId?: ThreadId;
      readonly projectId?: ProjectId;
    }) => Effect.Effect<ComputerTaskView, ComputerError>;
    /** Starts a task that works toward a goal on the screen; the host runs it and asks here for each step. */
    readonly startUse: (input: {
      readonly goal: string;
      readonly text?: string;
      readonly hostId?: ComputerHostId;
      readonly requester: string;
      readonly threadId?: ThreadId;
      readonly projectId?: ProjectId;
    }) => Effect.Effect<ComputerTaskView, ComputerError>;
    /** One step the agent chose, run as a one-step task through the same grants, approvals and audit. */
    readonly act: (input: {
      readonly act: ComputerAct;
      readonly text?: string;
      readonly hostId?: ComputerHostId;
      readonly requester: string;
      readonly threadId?: ThreadId;
      readonly projectId?: ProjectId;
    }) => Effect.Effect<ComputerTaskView, ComputerError>;
    /** Reads a window without changing anything: no task and no approval. */
    readonly look: (input: {
      readonly hostId?: ComputerHostId;
      readonly app?: string;
      readonly screenshot?: boolean;
      readonly region?: ComputerRect;
      readonly requester: string;
    }) => Effect.Effect<ComputerLook, ComputerError>;
    /** Answers the planner's questions for one step, and returns what the host was given. */
    readonly answerDecision: (input: {
      readonly taskId: ComputerTaskId;
      readonly decisionId: string;
      readonly answers: ComputerPlannerAnswers;
      readonly answeredBy: string;
      /** The agent's thread: only the thread that started a task answers its questions. */
      readonly threadId?: ThreadId;
    }) => Effect.Effect<ComputerAnswers, ComputerError>;
    /** The hosts, the tasks and the approvals a client draws. */
    readonly status: Effect.Effect<ComputerSnapshot>;
    /** Stops one task, or every running one. */
    readonly stop: (input: {
      readonly taskId?: ComputerTaskId;
      readonly by: string;
      readonly reason?: string;
    }) => Effect.Effect<void>;
    /** The thread's run ended or was interrupted: its computer tasks end too. */
    readonly stopForThread: (threadId: ThreadId) => Effect.Effect<void>;
    /** Snapshots as they change, the current one first. */
    readonly subscribe: Effect.Effect<Stream.Stream<ComputerSnapshot>>;
    readonly respondToApproval: (input: {
      readonly approvalId: ComputerApprovalId;
      readonly approve: boolean;
      readonly decidedBy: string;
    }) => Effect.Effect<void, ComputerError>;
    readonly auditTail: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>>;
    /** A host's session: the frames it must do, then its end when it goes away. */
    readonly hostConnect: (
      input: ComputerHostConnectInput,
    ) => Stream.Stream<ComputerHostFrame, ComputerError>;
    readonly hostRespond: (input: {
      readonly hostId: ComputerHostId;
      readonly reply: ComputerHostReply;
    }) => Effect.Effect<void, ComputerError>;
    readonly hostDecide: (input: {
      readonly hostId: ComputerHostId;
      readonly taskId: ComputerTaskId;
      readonly state: unknown;
      readonly questions: ComputerQuestions;
    }) => Effect.Effect<ComputerAnswers, ComputerError>;
    readonly hostAuthorize: (input: {
      readonly hostId: ComputerHostId;
      readonly taskId: ComputerTaskId;
      readonly step: number;
      readonly observation: ComputerObservation;
      readonly action: ComputerApprovalBinding["action"];
    }) => Effect.Effect<ComputerGrant, ComputerError>;
    readonly hostEvent: (input: {
      readonly hostId: ComputerHostId;
      readonly taskId: ComputerTaskId;
      readonly event: ComputerHostEvent;
    }) => Effect.Effect<void, ComputerError>;
    /** The grants a host checked again, so the snapshot never shows the ones it connected with. */
    readonly hostAccess: (input: {
      readonly hostId: ComputerHostId;
      readonly access: ComputerHostAccess;
    }) => Effect.Effect<void, ComputerError>;
    /** An in-process host, for a standalone server that runs the helper itself. */
    readonly attachLocalHost: (
      input: ComputerHostConnectInput & {
        readonly send: (frame: ComputerHostFrame) => void;
      },
    ) => Effect.Effect<{ readonly hostId: ComputerHostId; readonly detach: Effect.Effect<void> }>;
  }
>()("t3/computer/ComputerService") {}

const make = Effect.gen(function* () {
  const approvals = yield* ComputerApprovals.ComputerApprovals;
  const audit = yield* ComputerAudit.ComputerAudit;
  const decider = yield* ComputerDecider.ComputerDecider;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const random = yield* SecureRandom.SecureRandom;
  const stateRef = yield* Ref.make<ServiceState>(EMPTY);
  const changes = yield* PubSub.sliding<ComputerSnapshot>(1);
  // Publishes happen one at a time, so a reader never sees an older snapshot after a newer one.
  const publishLock = yield* Semaphore.make(1);

  // Published on every change; the span would be per step and the callers' spans cover it.
  const snapshotOf = Effect.fnUntraced(function* (withQuestions: boolean) {
    const state = yield* Ref.get(stateRef);
    const listed = yield* approvals.list;
    return {
      hosts: state.hosts.map(hostView),
      tasks: state.tasks.toReversed().map((task) => taskView(task, withQuestions)),
      approvals: listed,
    } satisfies ComputerSnapshot;
  });
  const status = snapshotOf(true);
  const clientSnapshot = snapshotOf(false);

  const publish = Effect.gen(function* () {
    const next = yield* clientSnapshot;
    yield* PubSub.publish(changes, next);
  });

  /** One short, atomic change, then one snapshot. Never wraps a wait for a person or a model. */
  const mutate = <A>(change: (state: ServiceState) => readonly [A, ServiceState]) =>
    publishLock.withPermits(1)(
      Effect.gen(function* () {
        const result = yield* Ref.modify(stateRef, change);
        yield* publish;
        return result;
      }),
    );

  /** A change no client draws (budget counters): no snapshot. */
  const update = (change: (state: ServiceState) => ServiceState) => Ref.update(stateRef, change);

  /** The step's setting, published only when it changed the task's "approvals off" label. */
  const refreshApprovalsMode = Effect.fnUntraced(function* (task: Task) {
    const mode = yield* approvalsModeFor(task.projectId);
    if (mode !== task.approvalsMode) {
      yield* mutate(
        (state) =>
          [
            undefined,
            patchTask(state, task.id, (running) => ({ ...running, approvalsMode: mode })),
          ] as const,
      );
    }
    return mode;
  });

  const record = (event: string, fields: Readonly<Record<string, unknown>> = {}) =>
    audit.record(event, fields);

  /** The project's setting, read now: a switch back to "ask" applies to the next step of a task running. */
  const approvalsModeFor = (projectId: ProjectId | null): Effect.Effect<ComputerApprovalsMode> =>
    settings.getSettings.pipe(
      Effect.map(
        (current) => resolveProjectSettings(current, projectId).settings.computerApprovals,
      ),
      Effect.orElseSucceed(() => "ask" as const),
    );

  /** The task's end, once: its host is freed, and nothing it waited for can still be granted. */
  const finishTask = Effect.fn("ComputerService.finishTask")(function* (input: {
    readonly taskId: ComputerTaskId;
    readonly status: ComputerTaskStatus;
    readonly reason: string;
    readonly surface?: string | null;
  }) {
    const nowMs = yield* Clock.currentTimeMillis;
    const ended = yield* mutate((state) => {
      const task = state.tasks.find((candidate) => candidate.id === input.taskId);
      if (task === undefined || task.status !== "running") return [null, state] as const;
      const finished: Task = {
        ...task,
        status: input.status,
        reason: clip(input.reason).slice(0, 600),
        surface: input.surface == null ? task.surface : clip(input.surface),
        endedAtMs: nowMs,
        approvalId: null,
        decision: null,
      };
      const approvalsPending = [...state.approvals.entries()].filter(
        ([, entry]) => entry.taskId === input.taskId,
      );
      const remaining = new Map(state.approvals);
      for (const [approvalId] of approvalsPending) remaining.delete(approvalId);
      return [
        { task: finished, decision: task.decision, approvals: approvalsPending },
        {
          ...state,
          tasks: withoutOldEnded(replaceTask(state, finished).tasks),
          approvals: remaining,
          hosts: state.hosts.map((host) =>
            host.taskId === input.taskId ? { ...host, taskId: null } : host,
          ),
        },
      ] as const;
    });
    if (ended === null) return null;
    yield* approvals.cancelTask(input.taskId);
    for (const [, entry] of ended.approvals) yield* Deferred.succeed(entry.wake, "cancelled");
    if (ended.decision !== null) {
      yield* Deferred.fail(
        ended.decision.wake,
        failure("stopped", "The step ended before it was answered.", { taskId: input.taskId }),
      );
    }
    yield* record("task.end", {
      taskId: input.taskId,
      status: input.status,
      reason: ended.task.reason,
      steps: ended.task.steps.length,
      surface: ended.task.surface,
      ms: ended.task.endedAtMs === null ? 0 : ended.task.endedAtMs - ended.task.startedAtMs,
      waitedMs: ended.task.waitedMs,
    });
    return ended.task;
  });

  const deny = Effect.fn("ComputerService.deny")(function* (
    taskId: ComputerTaskId,
    reason: string,
  ) {
    yield* record("deny", { taskId, reason });
    yield* finishTask({ taskId, status: "blocked", reason });
    return { ok: false, denied: reason } satisfies ComputerGrant;
  });

  const pickHost = Effect.fnUntraced(function* (hostId: ComputerHostId | undefined) {
    const state = yield* Ref.get(stateRef);
    if (hostId !== undefined) {
      const host = state.hosts.find((candidate) => candidate.id === hostId);
      if (host === undefined) {
        return yield* failure("no_host", NO_COMPUTER, { hostId });
      }
      return host;
    }
    const only = state.hosts[0];
    if (only === undefined) return yield* failure("no_host", NO_COMPUTER);
    if (state.hosts.length > 1) {
      return yield* failure("no_host", "More than one computer is connected; name the one to use.");
    }
    return only;
  });

  const projectFor = (input: {
    readonly threadId?: ThreadId;
    readonly projectId?: ProjectId;
  }): Effect.Effect<ProjectId | null> => {
    if (input.projectId !== undefined) return Effect.succeed(input.projectId);
    if (input.threadId === undefined) return Effect.succeed(null);
    return projections.getThreadShell(input.threadId).pipe(
      Effect.map((shell) => shell?.projectId ?? null),
      Effect.orElseSucceed(() => null),
    );
  };

  /** A server command to a host, with its reply; a host that goes away fails it at once. */
  const askHost = Effect.fnUntraced(function* (
    host: Host,
    frame: (requestId: string) => ComputerHostFrame,
  ) {
    const requestId = yield* random.uuidV4();
    const reply = yield* Deferred.make<ComputerHostReply, ComputerError>();
    const registered = yield* mutate((state) => {
      const current = state.hosts.find((candidate) => candidate.id === host.id);
      if (current === undefined) return [false, state] as const;
      return [
        true,
        {
          ...state,
          replies: new Map(state.replies).set(requestId, { hostId: host.id, reply }),
        },
      ] as const;
    });
    if (!registered) {
      return yield* failure("no_host", NO_COMPUTER, { hostId: host.id });
    }
    host.send(frame(requestId));
    return yield* Deferred.await(reply).pipe(
      Effect.timeoutOrElse({
        duration: REPLY_TIMEOUT,
        orElse: () =>
          Effect.fail(failure("unavailable", `${host.name} did not answer.`, { hostId: host.id })),
      }),
      Effect.ensuring(
        mutate((state) => {
          const replies = new Map(state.replies);
          replies.delete(requestId);
          return [undefined, { ...state, replies }] as const;
        }),
      ),
    );
  });

  const recordTaskStart = (task: Task) =>
    record("task.start", {
      taskId: task.id,
      kind: task.kind,
      hostId: task.hostId,
      hostName: task.hostName,
      goal: task.goal,
      textLength: task.text === null ? null : textDigest(task.text).len,
      textSha256: task.text === null ? null : textDigest(task.text).sha256,
      requester: task.requester,
      threadId: task.threadId,
    });

  const newTask = Effect.fnUntraced(function* (input: {
    host: Host;
    kind: ComputerTaskKind;
    goal: string;
    text: string | null;
    requester: string;
    threadId: ThreadId | null;
    projectId: ProjectId | null;
  }) {
    const nowMs = yield* Clock.currentTimeMillis;
    const mode = yield* approvalsModeFor(input.projectId);
    const prefix = input.kind === "use" ? "cu" : "cc";
    const task: Task = {
      id: `${prefix}_${yield* random.uuidV4()}`,
      kind: input.kind,
      hostId: input.host.id,
      hostName: input.host.name,
      goal: input.goal,
      text: input.text,
      requester: input.requester,
      threadId: input.threadId,
      projectId: input.projectId,
      startedAtMs: nowMs,
      status: "running",
      reason: "",
      surface: "",
      steps: [],
      endedAtMs: null,
      waitedMs: 0,
      authorized: 0,
      decided: 0,
      approvalId: null,
      decision: null,
      grounderFailed: false,
      approvalsMode: mode,
      screenText: "",
    };
    const created = yield* mutate((state) => {
      const host = state.hosts.find((candidate) => candidate.id === input.host.id);
      if (host === undefined || host.taskId !== null) return [false, state] as const;
      return [
        true,
        {
          ...state,
          tasks: [...state.tasks, task],
          hosts: state.hosts.map((candidate) =>
            candidate.id === host.id ? { ...candidate, taskId: task.id } : candidate,
          ),
        },
      ] as const;
    });
    if (!created) {
      return yield* failure(
        "busy",
        `${input.host.name} is busy with another task; stop it first.`,
        {
          hostId: input.host.id,
        },
      );
    }
    yield* recordTaskStart(task);
    return task;
  });

  const waitForTap = Effect.fn("ComputerService.waitForTap")(function* (
    taskId: ComputerTaskId,
    binding: ComputerApprovalBinding,
  ) {
    // The wait starts when the approval is made: publishing it and the audit line are not working time.
    const startedAtMs = yield* Clock.currentTimeMillis;
    const approval = yield* approvals
      .create(binding)
      .pipe(
        Effect.mapError((cause) =>
          failure(
            "unavailable",
            cause._tag === "ComputerApprovalLimitError"
              ? cause.message
              : "Too many approvals are waiting.",
            { taskId },
          ),
        ),
      );
    const wake = yield* Deferred.make<ApprovalWake>();
    yield* mutate(
      (state) =>
        [
          undefined,
          {
            ...patchTask(state, taskId, (task) => ({ ...task, approvalId: approval.id })),
            approvals: new Map(state.approvals).set(approval.id, { taskId, wake }),
          },
        ] as const,
    );
    yield* record(APPROVAL_REQUEST_AUDIT_EVENT, {
      approvalId: approval.id,
      ...approvalAuditFields(binding),
    });
    const woken = yield* Deferred.await(wake).pipe(
      Effect.timeoutOrElse({
        duration: APPROVAL_TIMEOUT,
        orElse: () => Effect.succeed("timeout" as const),
      }),
    );
    const result = yield* approvals.take({ approvalId: approval.id, binding });
    const nowMs = yield* Clock.currentTimeMillis;
    yield* mutate((state) => {
      const pending = new Map(state.approvals);
      pending.delete(approval.id);
      return [
        undefined,
        {
          ...patchTask(state, taskId, (task) => ({
            ...task,
            approvalId: null,
            waitedMs: task.waitedMs + Math.max(0, nowMs - startedAtMs),
          })),
          approvals: pending,
        },
      ] as const;
    });
    yield* record("approval.end", {
      approvalId: approval.id,
      taskId,
      outcome: result,
      woken,
    });
    if (result === "approved") return { _tag: "approved" } as const;
    if (result === "denied") return { _tag: "denied" } as const;
    if (result === "cancelled") return { _tag: "cancelled" } as const;
    return { _tag: "expired" } as const;
  });

  /** The lock-screen control's tap, and the setting that skips it. */
  const controlTap = Effect.fnUntraced(function* (input: {
    task: Task;
    host: Host;
    decision: ComputerDecision;
  }) {
    const mode = yield* refreshApprovalsMode(input.task);
    const binding: ComputerApprovalBinding = {
      hostId: input.host.id,
      taskId: input.task.id,
      step: 0,
      app: input.host.name,
      title: "",
      url: "",
      action: { kind: "control", name: input.task.goal },
      why: input.decision.why,
      goal: input.task.goal,
      requester: input.task.requester,
    };
    if (mode === "skip") {
      yield* record(APPROVAL_SKIPPED_AUDIT_EVENT, approvalAuditFields(binding));
      return "approved" as const;
    }
    const outcome = yield* waitForTap(input.task.id, binding);
    if (outcome._tag === "approved") return "approved" as const;
    if (outcome._tag === "cancelled") return "stopped" as const;
    yield* deny(
      input.task.id,
      outcome._tag === "denied"
        ? "You said no on the approval screen."
        : "Nobody approved it in time.",
    );
    return "denied" as const;
  });

  const control: ComputerService["Service"]["control"] = Effect.fn("ComputerService.control")(
    function* (input) {
      const decision = controlPolicy(input.control.kind);
      if (decision.verdict === "refused") {
        return yield* failure("refused", decision.why);
      }
      const host = yield* pickHost(input.hostId);
      if (!host.controls.includes(input.control.kind)) {
        return yield* failure("unavailable", `${host.name} does not offer ${input.control.kind}.`, {
          hostId: host.id,
        });
      }
      if (host.taskId !== null) {
        return yield* failure("busy", `${host.name} is busy with another task; stop it first.`, {
          hostId: host.id,
        });
      }
      const projectId = yield* projectFor(input);
      const task = yield* newTask({
        host,
        kind: "control",
        goal: describeControl(input.control),
        text: null,
        requester: input.requester,
        threadId: input.threadId ?? null,
        projectId,
      });
      if (decision.verdict === "tap") {
        const granted = yield* controlTap({ task, host, decision });
        if (granted === "stopped") {
          return yield* failure("stopped", "It was stopped.", { taskId: task.id });
        }
        if (granted === "denied") {
          return yield* failure("refused", "You said no on the approval screen.", {
            taskId: task.id,
          });
        }
      }
      const reply = yield* askHost(host, (requestId) => ({
        kind: "control",
        requestId,
        taskId: task.id,
        control: input.control,
      })).pipe(Effect.result);
      if (reply._tag === "Failure") {
        yield* finishTask({
          taskId: task.id,
          status: "failed",
          reason: reply.failure.message,
        });
        return yield* reply.failure;
      }
      if (!reply.success.ok) {
        const reason = reply.success.error ?? "The computer could not do it.";
        yield* finishTask({ taskId: task.id, status: "failed", reason });
        return yield* failure("unavailable", reason, { taskId: task.id, hostId: host.id });
      }
      const done = reply.success.done ?? "Done.";
      const ended = yield* finishTask({ taskId: task.id, status: "done", reason: done });
      return taskView(ended ?? task);
    },
  );

  /** A task the host runs and asks here for each step: a goal it works toward, or one act. */
  const begin = Effect.fnUntraced(function* (input: {
    readonly goal: string;
    readonly text?: string;
    readonly act?: ComputerAct;
    readonly hostId?: ComputerHostId;
    readonly requester: string;
    readonly threadId?: ThreadId;
    readonly projectId?: ProjectId;
  }) {
    const goal = input.goal;
    if (input.text !== undefined && input.text.length > MAX_TEXT) {
      return yield* failure("refused", `The text is at most ${MAX_TEXT} characters.`);
    }
    const host = yield* pickHost(input.hostId);
    if (host.taskId !== null) {
      return yield* failure("busy", `${host.name} is busy with another task; stop it first.`, {
        hostId: host.id,
      });
    }
    const projectId = yield* projectFor(input);
    const task = yield* newTask({
      host,
      kind: "use",
      goal,
      text: input.text ?? null,
      requester: input.requester,
      threadId: input.threadId ?? null,
      projectId,
    });
    const started = yield* askHost(host, (requestId) => ({
      kind: "start",
      requestId,
      taskId: task.id,
      goal,
      text: task.text,
      limits: COMPUTER_LIMITS,
      ...(input.act === undefined ? {} : { act: input.act }),
    })).pipe(Effect.result);
    if (started._tag === "Failure") {
      yield* finishTask({
        taskId: task.id,
        status: "failed",
        reason: started.failure.message,
      });
      return yield* started.failure;
    }
    if (!started.success.ok) {
      const reason = started.success.error ?? "The computer refused the task.";
      yield* finishTask({ taskId: task.id, status: "failed", reason });
      return yield* failure("refused", reason, { taskId: task.id });
    }
    return taskView(task);
  });

  const startUse: ComputerService["Service"]["startUse"] = Effect.fn("ComputerService.startUse")(
    function* (input) {
      const goal = input.goal.trim();
      if (goal.length === 0 || goal.length > MAX_GOAL) {
        return yield* failure("refused", `A goal is required, and at most ${MAX_GOAL} characters.`);
      }
      return yield* begin({ ...input, goal });
    },
  );

  const act: ComputerService["Service"]["act"] = Effect.fn("ComputerService.act")(
    function* (input) {
      const typed = input.act.action === "type" ? (input.text ?? "") : undefined;
      if (typed === "") return yield* failure("refused", "Give the exact `text` to type.");
      const { text: _text, ...rest } = input;
      return yield* begin({
        ...rest,
        goal: describeAct(input.act, typed ?? null),
        ...(typed === undefined ? {} : { text: typed }),
        act: input.act,
      });
    },
  );

  const look: ComputerService["Service"]["look"] = Effect.fn("ComputerService.look")(
    function* (input) {
      const host = yield* pickHost(input.hostId);
      const reply = yield* askHost(host, (requestId) => ({
        kind: "look",
        requestId,
        screenshot: input.screenshot === true,
        ...(input.app === undefined ? {} : { app: input.app }),
        ...(input.region === undefined ? {} : { region: input.region }),
      }));
      if (!reply.ok || reply.look === undefined) {
        return yield* failure(
          "unavailable",
          reply.error ?? `${host.name} could not read its screen.`,
          {
            hostId: host.id,
          },
        );
      }
      const seen = reply.look;
      yield* record("look", {
        hostId: host.id,
        requester: input.requester,
        app: clip(seen.app),
        title: clip(seen.title),
        controls: seen.controls.length,
        screenshot:
          seen.screenshot === undefined
            ? null
            : { width: seen.screenshot.width, height: seen.screenshot.height },
      });
      return seen;
    },
  );

  /** The planner's turn at the questions; it answers through `answerDecision`. */
  const askPlanner = Effect.fnUntraced(function* (
    taskId: ComputerTaskId,
    questions: ComputerQuestions,
  ) {
    const decisionId = `dec_${yield* random.uuidV4()}`;
    const wake = yield* Deferred.make<ComputerAnswers, ComputerError>();
    yield* mutate(
      (state) =>
        [
          undefined,
          patchTask(state, taskId, (task) => ({
            ...task,
            decision: { id: decisionId, questions, wake },
          })),
        ] as const,
    );
    yield* record("decision.request", { taskId, decisionId });
    const startedAtMs = yield* Clock.currentTimeMillis;
    const answered = yield* Deferred.await(wake).pipe(
      Effect.timeoutOrElse({
        duration: PLANNER_TIMEOUT,
        orElse: () =>
          Effect.fail(failure("stopped", "The planner did not answer in time.", { taskId })),
      }),
      Effect.result,
    );
    const nowMs = yield* Clock.currentTimeMillis;
    yield* mutate(
      (state) =>
        [
          undefined,
          patchTask(state, taskId, (task) => ({
            ...task,
            decision: null,
            waitedMs: task.waitedMs + Math.max(0, nowMs - startedAtMs),
          })),
        ] as const,
    );
    if (answered._tag === "Failure") return yield* answered.failure;
    return answered.success;
  });

  const answerDecision: ComputerService["Service"]["answerDecision"] = Effect.fn(
    "ComputerService.answerDecision",
  )(function* (input) {
    const state = yield* Ref.get(stateRef);
    const task = state.tasks.find((candidate) => candidate.id === input.taskId);
    if (task === undefined) {
      return yield* failure("not_found", "That task is not known here.", { taskId: input.taskId });
    }
    if (
      task.threadId !== null &&
      input.threadId !== undefined &&
      task.threadId !== input.threadId
    ) {
      return yield* failure("not_found", "That task belongs to another thread.", {
        taskId: task.id,
      });
    }
    if (task.status !== "running") {
      return yield* failure("stopped", "That task has ended.", { taskId: task.id });
    }
    const pending = task.decision;
    if (pending === null || pending.id !== input.decisionId) {
      return yield* failure("not_found", "That task is not waiting for those answers.", {
        taskId: task.id,
      });
    }
    const converted = ComputerDecider.keepValid(
      pending.questions,
      plannerAnswers(pending.questions, input.answers),
    );
    const answered = yield* Deferred.succeed(pending.wake, converted).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!answered) {
      return yield* failure("stopped", "Those answers arrived after the step ended.", {
        taskId: task.id,
      });
    }
    yield* record("decision.answer", {
      taskId: task.id,
      decisionId: pending.id,
      by: input.answeredBy,
      answers: Object.entries(converted).map(([id, answer]) => ({
        id,
        type: answer.type,
        ...(answer.type === "choice" ? { choice: answer.choice } : {}),
        probability: answer.probability,
      })),
    });
    return converted;
  });

  const hostDecide: ComputerService["Service"]["hostDecide"] = Effect.fn(
    "ComputerService.hostDecide",
  )(function* (input) {
    const state = yield* Ref.get(stateRef);
    const host = state.hosts.find((candidate) => candidate.id === input.hostId);
    if (host === undefined) {
      return yield* failure("no_host", NO_COMPUTER, { hostId: input.hostId });
    }
    const task = state.tasks.find((candidate) => candidate.id === input.taskId);
    if (
      task === undefined ||
      task.kind !== "use" ||
      task.hostId !== host.id ||
      host.taskId !== task.id
    ) {
      return yield* failure("not_found", "That task is not this computer's running task.", {
        taskId: input.taskId,
        hostId: host.id,
      });
    }
    if (task.status !== "running") {
      return yield* failure("stopped", "The task was stopped.", { taskId: task.id });
    }
    if (task.decided >= 2 * COMPUTER_LIMITS.maxSteps + 4) {
      return yield* failure("refused", "The task used up its decisions.", { taskId: task.id });
    }
    const nowMs = yield* Clock.currentTimeMillis;
    if (
      nowMs - task.startedAtMs - task.waitedMs > COMPUTER_LIMITS.timeoutMs ||
      nowMs - task.startedAtMs > WALL_TIME_MS
    ) {
      return yield* failure("refused", "It was taking too long.", { taskId: task.id });
    }
    const screenText = screenTextOf(input.state, task.text);
    yield* update((current) =>
      patchTask(current, task.id, (running) => ({
        ...running,
        decided: running.decided + 1,
        screenText,
      })),
    );
    if (!task.grounderFailed) {
      const grounded = yield* decider.ask({ state: input.state, questions: input.questions });
      if (grounded._tag === "answers") {
        yield* record("decision.grounded", {
          taskId: task.id,
          asked: Object.keys(input.questions).length,
        });
        return grounded.answers;
      }
      if (grounded._tag === "failed") {
        yield* update((current) =>
          patchTask(current, task.id, (running) => ({ ...running, grounderFailed: true })),
        );
        yield* record("decision.grounder_failed", {
          taskId: task.id,
          detail: grounded.detail,
        });
      }
    }
    return yield* askPlanner(task.id, input.questions);
  });

  const hostAuthorize: ComputerService["Service"]["hostAuthorize"] = Effect.fn(
    "ComputerService.hostAuthorize",
  )(function* (input) {
    const state = yield* Ref.get(stateRef);
    const host = state.hosts.find((candidate) => candidate.id === input.hostId);
    if (host === undefined) {
      return yield* failure("no_host", NO_COMPUTER, { hostId: input.hostId });
    }
    const task = state.tasks.find((candidate) => candidate.id === input.taskId);
    if (task === undefined || task.kind !== "use" || task.hostId !== host.id) {
      return {
        ok: false,
        denied:
          "Ada lost track of this task, so the step was not done. This is an internal error, not a denial.",
      } as const;
    }
    if (task.status !== "running") {
      return { ok: false, denied: "It was stopped." } as const;
    }
    const nowMs = yield* Clock.currentTimeMillis;
    if (
      nowMs - task.startedAtMs - task.waitedMs > COMPUTER_LIMITS.timeoutMs ||
      nowMs - task.startedAtMs > WALL_TIME_MS
    ) {
      return yield* deny(task.id, "It was taking too long.");
    }
    // Checked and counted in one step, so two authorizations at once cannot both take the last one.
    const counted = yield* Ref.modify(stateRef, (current) => {
      const running = current.tasks.find((candidate) => candidate.id === task.id);
      if (running === undefined || running.authorized >= COMPUTER_LIMITS.maxSteps) {
        return [false, current] as const;
      }
      return [
        true,
        replaceTask(current, { ...running, authorized: running.authorized + 1, screenText: "" }),
      ] as const;
    });
    if (!counted) {
      return yield* deny(task.id, `It did not finish within ${COMPUTER_LIMITS.maxSteps} steps.`);
    }
    let decision = screen(input.action);
    let judged: number | null = null;
    if (decision.verdict === "judge") {
      const verdict = task.grounderFailed
        ? ({ _tag: "not_configured" } as const)
        : yield* decider.judge({
            state: {
              goal: task.goal,
              screen: input.observation,
              action: {
                kind: input.action.kind,
                role: input.action.role ?? "",
                label: input.action.label ?? "",
              },
            },
          });
      if (verdict._tag === "judged") {
        judged = verdict.probability;
        decision = afterJudge(verdict.probability);
      } else {
        if (verdict._tag === "failed") {
          yield* update((current) =>
            patchTask(current, task.id, (running) => ({ ...running, grounderFailed: true })),
          );
        }
        decision = afterJudge(null);
      }
    }
    if (decision.verdict === "refused") return yield* deny(task.id, decision.why);
    if (decision.verdict === "auto") {
      yield* record("grant", {
        taskId: task.id,
        step: input.step,
        judged,
        action: actionAuditFields(input.action),
      });
      return { ok: true, grant: "allow" } as const;
    }
    const mode = yield* refreshApprovalsMode(task);
    const binding: ComputerApprovalBinding = {
      hostId: host.id,
      taskId: task.id,
      step: input.step,
      app: input.observation.app,
      title: input.observation.title,
      url: input.observation.url ?? "",
      action: input.action,
      why: decision.why,
      goal: task.goal,
      requester: task.requester,
    };
    // The real pointer is the person's to lend, whatever the approvals setting.
    if (mode === "skip" && input.action.kind !== "pointer") {
      yield* record(APPROVAL_SKIPPED_AUDIT_EVENT, approvalAuditFields(binding));
      yield* record("grant", {
        taskId: task.id,
        step: input.step,
        judged,
        approved: true,
        skipped: true,
        action: actionAuditFields(input.action),
      });
      return { ok: true, grant: "approved" } as const;
    }
    const outcome = yield* waitForTap(task.id, binding);
    if (outcome._tag === "approved") {
      yield* record("grant", {
        taskId: task.id,
        step: input.step,
        judged,
        approved: true,
        action: actionAuditFields(input.action),
      });
      return { ok: true, grant: "approved" } as const;
    }
    if (outcome._tag === "denied") {
      return yield* deny(task.id, "You said no on the approval screen.");
    }
    if (outcome._tag === "expired") return yield* deny(task.id, "Nobody approved it in time.");
    return { ok: false, denied: "It was stopped." } as const;
  });

  const hostEvent: ComputerService["Service"]["hostEvent"] = Effect.fn("ComputerService.hostEvent")(
    function* (input) {
      const state = yield* Ref.get(stateRef);
      const host = state.hosts.find((candidate) => candidate.id === input.hostId);
      if (host === undefined) {
        return yield* failure("no_host", NO_COMPUTER, { hostId: input.hostId });
      }
      const task = state.tasks.find((candidate) => candidate.id === input.taskId);
      if (task === undefined || task.hostId !== host.id || host.taskId !== task.id) {
        return yield* failure("not_found", "That task is not this computer's running task.", {
          taskId: input.taskId,
          hostId: host.id,
        });
      }
      if (input.event.type === "acted") {
        yield* record("act", {
          taskId: task.id,
          kind: input.event.kind,
          mode: input.event.mode,
          how: clip(input.event.how),
        });
        return;
      }
      if (input.event.type === "step") {
        if (task.status !== "running") return;
        const text = clip(input.event.text).slice(0, MAX_STEP_TEXT);
        yield* mutate(
          (current) =>
            [
              undefined,
              patchTask(current, task.id, (running) => ({
                ...running,
                steps: [...running.steps, text],
              })),
            ] as const,
        );
        yield* record("task.progress", { taskId: task.id, step: text });
        return;
      }
      yield* finishTask({
        taskId: task.id,
        status: input.event.status,
        reason: input.event.reason,
        surface: input.event.surface,
      });
    },
  );

  /** Ends each running task that matches, and tells its computer to stop at once. */
  const stopTasks = Effect.fnUntraced(function* (
    matches: (task: Task) => boolean,
    by: string,
    reason: string,
  ) {
    const state = yield* Ref.get(stateRef);
    const targets = state.tasks.filter((task) => task.status === "running" && matches(task));
    for (const task of targets) {
      yield* record("task.stop", { taskId: task.id, by });
      const ended = yield* finishTask({ taskId: task.id, status: "stopped", reason });
      if (ended === null) continue;
      state.hosts
        .find((candidate) => candidate.id === task.hostId)
        ?.send({ kind: "stop", requestId: `stop_${task.id}`, taskId: task.id, reason });
    }
  });

  const stop: ComputerService["Service"]["stop"] = Effect.fn("ComputerService.stop")((input) =>
    stopTasks(
      (task) => input.taskId === undefined || task.id === input.taskId,
      input.by,
      input.reason ?? "You stopped it.",
    ),
  );

  const stopForThread = Effect.fn("ComputerService.stopForThread")(
    (threadId: ThreadId) =>
      stopTasks(
        (task) => task.threadId === threadId,
        "thread interrupt",
        "The thread's run was interrupted.",
      ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Computer use could not be stopped for an interrupted run", { cause }),
    ),
  );

  const respondToApproval: ComputerService["Service"]["respondToApproval"] = Effect.fn(
    "ComputerService.respondToApproval",
  )(function* (input) {
    const decided = yield* approvals.decide({
      approvalId: input.approvalId,
      approve: input.approve,
      decidedBy: input.decidedBy,
    });
    if (decided !== "ok") {
      return yield* failure(
        decided === "unknown" ? "not_found" : "stopped",
        decided === "unknown"
          ? "That approval is not waiting."
          : decided === "expired"
            ? "That approval expired."
            : "That approval was already answered.",
      );
    }
    const pending = yield* mutate((state) => {
      const entry = state.approvals.get(input.approvalId);
      if (entry === undefined) return [null, state] as const;
      const next = new Map(state.approvals);
      next.delete(input.approvalId);
      return [entry, { ...state, approvals: next }] as const;
    });
    if (pending === null) return;
    yield* Deferred.succeed(pending.wake, "answered");
    yield* record("approval.decision", {
      approvalId: input.approvalId,
      taskId: pending.taskId,
      approve: input.approve,
      decidedBy: input.decidedBy,
    });
  });

  const unregisterHost = Effect.fn("ComputerService.unregisterHost")(function* (
    hostId: ComputerHostId,
  ) {
    const removed = yield* mutate((state) => {
      const host = state.hosts.find((candidate) => candidate.id === hostId);
      if (host === undefined) return [null, state] as const;
      const replies = new Map(state.replies);
      const failed: Array<Deferred.Deferred<ComputerHostReply, ComputerError>> = [];
      for (const [requestId, entry] of state.replies) {
        if (entry.hostId !== hostId) continue;
        replies.delete(requestId);
        failed.push(entry.reply);
      }
      return [
        { host, failed },
        {
          ...state,
          hosts: state.hosts.filter((candidate) => candidate.id !== hostId),
          replies,
        },
      ] as const;
    });
    if (removed === null) return;
    for (const reply of removed.failed) {
      yield* Deferred.fail(reply, failure("no_host", "The computer disconnected.", { hostId }));
    }
    yield* record("host.disconnected", { hostId });
    if (removed.host.taskId !== null) {
      yield* finishTask({
        taskId: removed.host.taskId,
        status: "failed",
        reason: "The computer disconnected.",
      });
    }
  });

  const registerHost = Effect.fnUntraced(function* (input: {
    readonly hello: ComputerHostConnectInput;
    readonly send: (frame: ComputerHostFrame) => void;
    readonly end: () => Effect.Effect<void>;
  }) {
    const replaced = (yield* Ref.get(stateRef)).hosts.filter(
      (host) => host.device === input.hello.device,
    );
    for (const host of replaced) {
      yield* unregisterHost(host.id);
      yield* host.end();
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const host: Host = {
      id: `host_${yield* random.uuidV4()}`,
      name: clip(input.hello.name).slice(0, 80),
      device: input.hello.device,
      platform: input.hello.platform,
      version: input.hello.version,
      controls: [...new Set(input.hello.controls)],
      computerUse: input.hello.computerUse,
      accessibility: input.hello.accessibility,
      screenRecording: input.hello.screenRecording,
      connectedAtMs: nowMs,
      taskId: null,
      send: input.send,
      end: input.end,
    };
    yield* mutate((state) => [undefined, { ...state, hosts: [...state.hosts, host] }] as const);
    yield* record("host.connected", {
      hostId: host.id,
      name: host.name,
      device: host.device,
      version: host.version,
      computerUse: host.computerUse,
      accessibility: host.accessibility,
    });
    return host;
  });

  const hostConnect: ComputerService["Service"]["hostConnect"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<ComputerHostFrame, Cause.Done>();
        const host = yield* registerHost({
          hello: input,
          send: (frame) => {
            Queue.offerUnsafe(queue, frame);
          },
          end: () => Queue.end(queue),
        });
        yield* Queue.offer(queue, { kind: "welcome", hostId: host.id, limits: COMPUTER_LIMITS });
        yield* Effect.addFinalizer(() => unregisterHost(host.id));
        return Stream.fromQueue(queue);
      }),
    );

  const hostRespond: ComputerService["Service"]["hostRespond"] = Effect.fn(
    "ComputerService.hostRespond",
  )(function* (input) {
    const reply = yield* mutate((state) => {
      const entry = state.replies.get(input.reply.requestId);
      if (entry === undefined || entry.hostId !== input.hostId) return [null, state] as const;
      const replies = new Map(state.replies);
      replies.delete(input.reply.requestId);
      return [entry.reply, { ...state, replies }] as const;
    });
    if (reply === null) {
      return yield* failure("not_found", "That reply does not match a request in flight.", {
        hostId: input.hostId,
      });
    }
    yield* Deferred.succeed(reply, input.reply);
  });

  const hostAccess: ComputerService["Service"]["hostAccess"] = Effect.fn(
    "ComputerService.hostAccess",
  )(function* ({ hostId, access }) {
    const host = (yield* Ref.get(stateRef)).hosts.find((candidate) => candidate.id === hostId);
    if (host === undefined) {
      return yield* failure("no_host", "That computer is not connected.", { hostId });
    }
    if (
      host.computerUse === access.computerUse &&
      host.accessibility === access.accessibility &&
      host.screenRecording === access.screenRecording
    ) {
      return;
    }
    yield* mutate(
      (state) =>
        [
          undefined,
          {
            ...state,
            hosts: state.hosts.map((candidate) =>
              candidate.id === hostId ? { ...candidate, ...access } : candidate,
            ),
          },
        ] as const,
    );
    yield* record("host.access", { hostId, ...access });
  });

  const attachLocalHost: ComputerService["Service"]["attachLocalHost"] = Effect.fn(
    "ComputerService.attachLocalHost",
  )(function* (input) {
    const host = yield* registerHost({
      hello: input,
      send: input.send,
      end: () => Effect.void,
    });
    input.send({ kind: "welcome", hostId: host.id, limits: COMPUTER_LIMITS });
    return { hostId: host.id, detach: unregisterHost(host.id) };
  });

  const subscribe = Effect.gen(function* () {
    const current = yield* clientSnapshot;
    return Stream.concat(Stream.make(current), Stream.fromPubSub(changes));
  });

  const auditTail = Effect.fn("ComputerService.auditTail")((limit: number) => audit.tail(limit));

  return ComputerService.of({
    control,
    startUse,
    act,
    look,
    answerDecision,
    status,
    stop,
    stopForThread,
    subscribe,
    respondToApproval,
    auditTail,
    hostConnect,
    hostRespond,
    hostDecide,
    hostAuthorize,
    hostEvent,
    hostAccess,
    attachLocalHost,
  });
});

/** A planner's answers as probabilities, checked against the questions by `keepValid`. */
function plannerAnswers(
  questions: ComputerQuestions,
  answers: ComputerPlannerAnswers,
): Readonly<Record<string, ComputerAnswers[string]>> {
  const probability = (confidence: "high" | "medium" | "low") =>
    confidence === "high" ? 0.9 : confidence === "medium" ? 0.6 : 0.3;
  const converted: Record<string, ComputerAnswers[string]> = {};
  for (const [id, answer] of Object.entries(answers)) {
    const question = questions[id];
    if (question === undefined) continue;
    const p = probability(answer.confidence);
    if (question.type === "choice") {
      if (answer.choice !== undefined && Object.hasOwn(question.criteria, answer.choice)) {
        converted[id] = { type: "choice", choice: answer.choice, probability: p };
      }
      continue;
    }
    if (answer.answer !== undefined) {
      converted[id] = { type: "noul", probability: answer.answer ? p : 1 - p };
    } else if (answer.choice === "yes" || answer.choice === "no") {
      converted[id] = { type: "noul", probability: answer.choice === "yes" ? p : 1 - p };
    }
  }
  return converted;
}

export const layer = Layer.effect(ComputerService, make);
