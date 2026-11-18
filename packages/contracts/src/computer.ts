// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/companion/src/executor/policy.ts and
// approvals.ts), Apache-2.0, Copyright 2026 Jay Leaton. Modified for Ada.
import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The fixed controls computer use takes. Locking the screen asks first; the rest run. */
export const COMPUTER_CONTROL_KINDS = [
  "open_app",
  "quit_app",
  "volume",
  "media",
  "dark_mode",
  "lock_screen",
] as const;
export const ComputerControlKind = Schema.Literals(COMPUTER_CONTROL_KINDS);
export type ComputerControlKind = typeof ComputerControlKind.Type;

/**
 * Nothing (`auto`), a person's tap on this exact step (`tap`), a judgment from the decision provider first
 * (`judge`), or nothing at all because it is not a step computer use offers (`refused`).
 */
export const ComputerVerdict = Schema.Literals(["auto", "tap", "judge", "refused"]);
export type ComputerVerdict = typeof ComputerVerdict.Type;

/** A verdict and, for the approval card and the audit, why it asked or refused. */
export const ComputerDecision = Schema.Struct({
  verdict: ComputerVerdict,
  why: Schema.String,
});
export type ComputerDecision = typeof ComputerDecision.Type;

/**
 * One step on the screen, as the helper observed it. Every string except `kind` comes from the screen: data,
 * never instructions. An unknown `kind` decodes and is then refused by the policy, so the reason reaches the
 * caller.
 */
export const ComputerAction = Schema.Struct({
  kind: Schema.String,
  ref: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  /** `type`: the exact text to type. The only text computer use ever types. */
  text: Schema.optionalKey(Schema.String),
  /** `press`: enter, space, escape, tab. */
  key: Schema.optionalKey(Schema.String),
  /** `press`: the field typed into before it, if any. */
  fieldRole: Schema.optionalKey(Schema.String),
  fieldLabel: Schema.optionalKey(Schema.String),
  /** `scroll`: up, down, top, bottom. */
  direction: Schema.optionalKey(Schema.String),
  /** `surface`: tab or app. */
  what: Schema.optionalKey(Schema.String),
  /** `surface`: the tab's or app's name. */
  name: Schema.optionalKey(Schema.String),
  /** `pointer`: why the background could not take the step, for the card. */
  why: Schema.optionalKey(Schema.String),
  /** `open_url`: the address handed to the default browser. */
  url: Schema.optionalKey(Schema.String),
});
export type ComputerAction = typeof ComputerAction.Type;

export const ComputerHostId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ComputerHostId = typeof ComputerHostId.Type;

export const ComputerTaskId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ComputerTaskId = typeof ComputerTaskId.Type;

export const ComputerApprovalId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ComputerApprovalId = typeof ComputerApprovalId.Type;

/**
 * What a tap approves, shown on the card in full and hashed into the approval: who asked, on which computer and
 * task, at which step, what was on screen, and the exact action.
 */
export const ComputerApprovalBinding = Schema.Struct({
  hostId: ComputerHostId,
  taskId: ComputerTaskId,
  step: NonNegativeInt,
  app: Schema.String,
  title: Schema.String,
  url: Schema.String,
  action: ComputerAction,
  /** The policy's reason, for the card. */
  why: Schema.String,
  /** What the person asked for. */
  goal: Schema.String,
  /** Who started the task, such as "agent: opencode". */
  requester: Schema.String,
});
export type ComputerApprovalBinding = typeof ComputerApprovalBinding.Type;

export const ComputerApprovalState = Schema.Literals([
  "pending",
  "approved",
  "denied",
  "expired",
  "used",
  "cancelled",
]);
export type ComputerApprovalState = typeof ComputerApprovalState.Type;

export const ComputerApproval = Schema.Struct({
  id: ComputerApprovalId,
  binding: ComputerApprovalBinding,
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  state: ComputerApprovalState,
  /** Empty until someone answers it. */
  decidedBy: Schema.String,
});
export type ComputerApproval = typeof ComputerApproval.Type;

/** A person's answer: only a pending, unexpired approval can be answered, once. */
export const ComputerApprovalDecideResult = Schema.Literals([
  "ok",
  "unknown",
  "not_pending",
  "expired",
]);
export type ComputerApprovalDecideResult = typeof ComputerApprovalDecideResult.Type;

/** A waiting step's check: `approved` once, for its own binding only, then `unknown`. */
export const ComputerApprovalTakeResult = Schema.Literals([
  "approved",
  "denied",
  "expired",
  "pending",
  "unknown",
  "mismatch",
  "cancelled",
]);
export type ComputerApprovalTakeResult = typeof ComputerApprovalTakeResult.Type;

export class ComputerApprovalLimitError extends Schema.TaggedError<ComputerApprovalLimitError>()(
  "ComputerApprovalLimitError",
  { limit: Schema.Int },
) {
  override get message(): string {
    return `Too many computer approvals are waiting; the limit is ${this.limit}.`;
  }
}

/** The budget both sides enforce: steps, working time, a tap's lifetime, and the waits that do not count. */
export const ComputerLimits = Schema.Struct({
  /** On-screen steps, not counting bringing a tab or app forward. */
  maxSteps: Schema.Int,
  /** Working time: wall time minus waits for a tap or the planner. */
  timeoutMs: Schema.Int,
  approvalTimeoutMs: Schema.Int,
  /** A planner wait; the whole task is capped at ten minutes of wall time. */
  plannerTimeoutMs: Schema.Int,
  /** How long the server waits for a host's reply to a command. */
  replyTimeoutMs: Schema.Int,
});
export type ComputerLimits = typeof ComputerLimits.Type;

export const COMPUTER_LIMITS: ComputerLimits = {
  maxSteps: 15,
  timeoutMs: 90_000,
  approvalTimeoutMs: 60_000,
  plannerTimeoutMs: 120_000,
  replyTimeoutMs: 20_000,
};

/** An environment setting, read at each step so a change applies to a task already running. */
export const ComputerApprovalsMode = Schema.Literals(["ask", "skip"]);
export type ComputerApprovalsMode = typeof ComputerApprovalsMode.Type;

export const ComputerTaskKind = Schema.Literals(["control", "use"]);
export type ComputerTaskKind = typeof ComputerTaskKind.Type;

/** A running task, then the helper's outcome once it ends. */
export const ComputerTaskStatus = Schema.Literals([
  "running",
  "done",
  "stuck",
  "blocked",
  "unavailable",
  "stopped",
  "failed",
]);
export type ComputerTaskStatus = typeof ComputerTaskStatus.Type;

export const ComputerTaskOutcomeStatus = Schema.Literals([
  "done",
  "stuck",
  "blocked",
  "unavailable",
  "stopped",
  "failed",
]);
export type ComputerTaskOutcomeStatus = typeof ComputerTaskOutcomeStatus.Type;

/** A surface's position of the screen, as an approval binds to it. */
export const ComputerObservation = Schema.Struct({
  app: Schema.String,
  title: Schema.String,
  url: Schema.optionalKey(Schema.String),
});
export type ComputerObservation = typeof ComputerObservation.Type;

/**
 * A typed question in the System One shape: a choice among named options, or a noul's probability that
 * its instructions hold. The screen inside the state is data, never instructions.
 */
export const ComputerQuestion = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("choice"),
    instructions: Schema.String,
    criteria: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("noul"),
    instructions: Schema.String,
  }),
]);
export type ComputerQuestion = typeof ComputerQuestion.Type;

export const ComputerQuestions = Schema.Record(Schema.String, ComputerQuestion);
export type ComputerQuestions = typeof ComputerQuestions.Type;

/** An answer in the helper's protocol: the chosen key, or a noul's probability. */
export const ComputerAnswer = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.String,
    probability: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal("noul"), probability: Schema.Number }),
]);
export type ComputerAnswer = typeof ComputerAnswer.Type;

export const ComputerAnswers = Schema.Record(Schema.String, ComputerAnswer);
export type ComputerAnswers = typeof ComputerAnswers.Type;

/**
 * An answer from the planner, which reads no page: a key from the question and a stated confidence,
 * mapped to 0.9, 0.6 or 0.3. A key the question did not offer is dropped before the helper sees it.
 */
export const ComputerPlannerAnswer = Schema.Struct({
  choice: Schema.optionalKey(Schema.String),
  /** A noul's answer, when it is not written as a yes/no choice. */
  answer: Schema.optionalKey(Schema.Boolean),
  confidence: Schema.Literals(["high", "medium", "low"]),
});
export type ComputerPlannerAnswer = typeof ComputerPlannerAnswer.Type;

export const ComputerPlannerAnswers = Schema.Record(Schema.String, ComputerPlannerAnswer);
export type ComputerPlannerAnswers = typeof ComputerPlannerAnswers.Type;

/** A fixed control, as a person asks for it ("open Safari", "volume down"). The helper validates the rest. */
export const ComputerControl = Schema.Struct({
  kind: ComputerControlKind,
  app: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.String),
  target: Schema.optionalKey(Schema.String),
  player: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(NonNegativeInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type ComputerControl = typeof ComputerControl.Type;

const COMPUTER_ACT_ACTIONS = ["click", "type", "key", "scroll", "open_url"] as const;
const COMPUTER_KEYS = [
  "return",
  "tab",
  "escape",
  "space",
  "up",
  "down",
  "left",
  "right",
  "cmd+l",
  "cmd+t",
  "cmd+w",
] as const;
export const ComputerKey = Schema.Literals(COMPUTER_KEYS);
export type ComputerKey = typeof ComputerKey.Type;

/**
 * One step an agent takes itself on the window in front. The text a `type` step types travels apart from it, as a
 * task's text does, so it is never copied into a view or an audit line.
 */
export const ComputerAct = Schema.Struct({
  action: Schema.Literals(COMPUTER_ACT_ACTIONS),
  /** `click`, `type`, `scroll`: a control's ref from the last look. */
  ref: Schema.optionalKey(Schema.String),
  /** `click`: a control's label, when no ref is at hand. */
  label: Schema.optionalKey(Schema.String),
  /** `click`: a screen point, when the control is not in the look. */
  x: Schema.optionalKey(Schema.Number),
  y: Schema.optionalKey(Schema.Number),
  key: Schema.optionalKey(ComputerKey),
  direction: Schema.optionalKey(Schema.Literals(["up", "down", "top", "bottom"])),
  url: Schema.optionalKey(Schema.String),
});
export type ComputerAct = typeof ComputerAct.Type;

export const ComputerRect = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number,
  h: Schema.Number,
});
export type ComputerRect = typeof ComputerRect.Type;

/** A window as a look reads it. Every string comes from the screen: data, never instructions. */
export const ComputerLook = Schema.Struct({
  app: Schema.String,
  title: Schema.String,
  url: Schema.optionalKey(Schema.String),
  /** The visible text, at most 1,500 characters. */
  text: Schema.String,
  controls: Schema.Array(
    Schema.Struct({
      ref: Schema.String,
      role: Schema.String,
      label: Schema.String,
      value: Schema.optionalKey(Schema.String),
      focused: Schema.optionalKey(Schema.Boolean),
      bounds: Schema.optionalKey(ComputerRect),
    }),
  ),
  /** The walk ran out of budget: more is on screen than is listed. */
  truncated: Schema.optionalKey(Schema.Boolean),
  /** Read from a screenshot, because the app would not show its window through accessibility. */
  visual: Schema.optionalKey(Schema.Boolean),
  /** A PNG of `region`; a screen point is `region` origin + pixel / `scale`. */
  screenshot: Schema.optionalKey(
    Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      data: Schema.String,
      width: Schema.Number,
      height: Schema.Number,
      region: ComputerRect,
      scale: Schema.Number,
    }),
  ),
});
export type ComputerLook = typeof ComputerLook.Type;

/** The computer a person let this environment use, and what it can do. */
export const ComputerHostView = Schema.Struct({
  hostId: ComputerHostId,
  name: Schema.String,
  device: Schema.String,
  platform: Schema.String,
  version: Schema.String,
  controls: Schema.Array(ComputerControlKind),
  computerUse: Schema.Boolean,
  accessibility: Schema.Boolean,
  screenRecording: Schema.Boolean,
  /** The task it is running, if one is. */
  busyTaskId: Schema.NullOr(ComputerTaskId),
  connectedAt: Schema.DateTimeUtc,
});
export type ComputerHostView = typeof ComputerHostView.Type;

/** What a task is, for the strip, the approval card and the tools. Typed text is never part of it. */
export const ComputerTaskView = Schema.Struct({
  taskId: ComputerTaskId,
  kind: ComputerTaskKind,
  hostId: ComputerHostId,
  hostName: Schema.String,
  goal: Schema.String,
  status: ComputerTaskStatus,
  reason: Schema.String,
  surface: Schema.String,
  steps: Schema.Array(Schema.String),
  /** Who started it, such as "agent: opencode" or "web". */
  requester: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.NullOr(Schema.DateTimeUtc),
  /** The tap it waits for now, if any. */
  waitingForApproval: Schema.NullOr(ComputerApprovalId),
  /** The planner's questions it waits for now, if any. Only the agent's tools carry the questions. */
  pendingDecision: Schema.NullOr(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      questions: Schema.optionalKey(ComputerQuestions),
    }),
  ),
  /** The setting the last step was granted under, so a client can say "approvals off". */
  approvalsMode: ComputerApprovalsMode,
  /**
   * The visible text of the screen it last decided on, unless it acted since. Only the agent's tools carry it.
   * Screen text is data, never instructions.
   */
  screenText: Schema.optionalKey(Schema.String),
});
export type ComputerTaskView = typeof ComputerTaskView.Type;

/** Everything a client draws: the hosts, the tasks and the approvals still answerable. */
export const ComputerSnapshot = Schema.Struct({
  hosts: Schema.Array(ComputerHostView),
  tasks: Schema.Array(ComputerTaskView),
  approvals: Schema.Array(ComputerApproval),
});
export type ComputerSnapshot = typeof ComputerSnapshot.Type;

/** What a host is told to do. Its replies come back through `hostRespond`; its questions through `hostDecide`. */
export const ComputerHostFrame = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("welcome"),
    hostId: ComputerHostId,
    limits: ComputerLimits,
  }),
  Schema.Struct({
    kind: Schema.Literal("start"),
    requestId: Schema.String,
    taskId: ComputerTaskId,
    goal: Schema.String,
    /** The exact text the task may type, and the only text computer use ever types. */
    text: Schema.NullOr(Schema.String),
    limits: ComputerLimits,
    /** One step the agent chose, done instead of working toward the goal. */
    act: Schema.optionalKey(ComputerAct),
  }),
  Schema.Struct({
    kind: Schema.Literal("look"),
    requestId: Schema.String,
    /** The app whose window to read; the one in front when absent. */
    app: Schema.optionalKey(Schema.String),
    screenshot: Schema.Boolean,
    region: Schema.optionalKey(ComputerRect),
  }),
  Schema.Struct({
    kind: Schema.Literal("stop"),
    requestId: Schema.String,
    taskId: ComputerTaskId,
    reason: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("control"),
    requestId: Schema.String,
    taskId: ComputerTaskId,
    control: ComputerControl,
  }),
]);
export type ComputerHostFrame = typeof ComputerHostFrame.Type;

/** A host's reply to a `start` or `control` frame. */
export const ComputerHostReply = Schema.Struct({
  requestId: Schema.String,
  ok: Schema.Boolean,
  /** What a control did, in words for the person. */
  done: Schema.optionalKey(Schema.String),
  /** Why it could not, for a person. */
  error: Schema.optionalKey(Schema.String),
  /** What a `look` read. */
  look: Schema.optionalKey(ComputerLook),
});
export type ComputerHostReply = typeof ComputerHostReply.Type;

/** What a running host reports: one step, then how the task ended. */
export const ComputerHostEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("step"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("finished"),
    status: ComputerTaskOutcomeStatus,
    reason: Schema.String,
    /** The steps it took, when the progress frames were not the whole story. */
    steps: Schema.Array(Schema.String),
    surface: Schema.NullOr(Schema.String),
  }),
  /** How one action reached the app, for the audit: never what it typed. */
  Schema.Struct({
    type: Schema.Literal("acted"),
    kind: Schema.String,
    mode: Schema.Literals(["background", "pointer"]),
    how: Schema.String,
  }),
]);
export type ComputerHostEvent = typeof ComputerHostEvent.Type;

/** The server's answer to one step: granted at once or after a tap, or refused with a reason for the person. */
export const ComputerGrant = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), grant: Schema.Literals(["allow", "approved"]) }),
  Schema.Struct({ ok: Schema.Literal(false), denied: Schema.String }),
]);
export type ComputerGrant = typeof ComputerGrant.Type;

export class ComputerError extends Schema.TaggedError<ComputerError>()("ComputerError", {
  reason: Schema.Literals(["no_host", "busy", "not_found", "stopped", "refused", "unavailable"]),
  /** The sentence a person sees. */
  detail: Schema.String,
  taskId: Schema.optionalKey(Schema.String),
  hostId: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return this.detail;
  }
}

export const ComputerStopInput = Schema.Struct({
  taskId: Schema.optionalKey(ComputerTaskId),
});
export type ComputerStopInput = typeof ComputerStopInput.Type;

export const ComputerRespondToApprovalInput = Schema.Struct({
  approvalId: ComputerApprovalId,
  approve: Schema.Boolean,
});
export type ComputerRespondToApprovalInput = typeof ComputerRespondToApprovalInput.Type;

export const ComputerAuditTailInput = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
});
export type ComputerAuditTailInput = typeof ComputerAuditTailInput.Type;

/** The macOS grants a host holds, as it last checked them. */
export const ComputerHostAccess = Schema.Struct({
  computerUse: Schema.Boolean,
  accessibility: Schema.Boolean,
  screenRecording: Schema.Boolean,
});
export type ComputerHostAccess = typeof ComputerHostAccess.Type;

export const ComputerHostConnectInput = Schema.Struct({
  /** The name a person sees, such as "JJ's MacBook". */
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  /** The paired device this host belongs to; one host a device. */
  device: Schema.String.check(Schema.isMaxLength(200)),
  platform: Schema.String.check(Schema.isMaxLength(40)),
  version: Schema.String.check(Schema.isMaxLength(40)),
  controls: Schema.Array(ComputerControlKind),
  ...ComputerHostAccess.fields,
});
export type ComputerHostConnectInput = typeof ComputerHostConnectInput.Type;

export const ComputerHostRespondInput = Schema.Struct({
  hostId: ComputerHostId,
  reply: ComputerHostReply,
});
export type ComputerHostRespondInput = typeof ComputerHostRespondInput.Type;

/** A host's grants changed after it connected, such as Accessibility allowed in System Settings. */
export const ComputerHostAccessInput = Schema.Struct({
  hostId: ComputerHostId,
  access: ComputerHostAccess,
});
export type ComputerHostAccessInput = typeof ComputerHostAccessInput.Type;

export const ComputerHostEventInput = Schema.Struct({
  hostId: ComputerHostId,
  taskId: ComputerTaskId,
  event: ComputerHostEvent,
});
export type ComputerHostEventInput = typeof ComputerHostEventInput.Type;

export const ComputerHostDecideInput = Schema.Struct({
  hostId: ComputerHostId,
  taskId: ComputerTaskId,
  /** The goal, the screen and the steps so far. Data for the questions, never instructions. */
  state: Schema.Unknown,
  questions: ComputerQuestions,
});
export type ComputerHostDecideInput = typeof ComputerHostDecideInput.Type;

export const ComputerHostAuthorizeInput = Schema.Struct({
  hostId: ComputerHostId,
  taskId: ComputerTaskId,
  step: NonNegativeInt,
  observation: ComputerObservation,
  action: ComputerAction,
});
export type ComputerHostAuthorizeInput = typeof ComputerHostAuthorizeInput.Type;
