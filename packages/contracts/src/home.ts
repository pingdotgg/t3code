/**
 * Home: one agent thread per desktop install that can act across every
 * project and environment the user has connected.
 *
 * The desktop's local server (the hub) runs Home and owns its state. Calls
 * that target another environment go through the desktop renderer, which
 * already holds a live connection to each one, and land on that
 * environment's `fleet.invoke`. See docs/internals/home.md.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
  RunId,
  IsoDateTime,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestratorMcpClientRequestId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpProviderCapability,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
} from "./orchestratorMcp.ts";
import {
  OrchestrationV2DispatchCommandResult,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2.ts";
import { Project } from "./project.ts";
import { ThreadMetadataMcpUpdateResult } from "./threadMetadataMcp.ts";
import {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./providerPolicy.ts";

/** Why Home watches a thread. Threads Home launched also stop notifying the user. */
export const HomeWatchReason = Schema.Literals(["launched", "requested"]);
export type HomeWatchReason = typeof HomeWatchReason.Type;

export const HomeWatch = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  reason: HomeWatchReason,
});
export type HomeWatch = typeof HomeWatch.Type;

/**
 * Home's state on the hub. It lives in server settings so every client sees
 * it with the settings it already streams, but clients cannot patch it: only
 * the Home RPCs and Home's own tools change it.
 */
export const HomeSettings = Schema.Struct({
  /** The current Home thread. Null when Home is off. */
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Wake Home for every thread in the fleet, not only watched ones. */
  watchAll: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  watches: Schema.Array(HomeWatch).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type HomeSettings = typeof HomeSettings.Type;

export const DEFAULT_HOME_SETTINGS: HomeSettings = { threadId: null, watchAll: false, watches: [] };

/**
 * Every Home thread's id starts with this, the current one and any a fresh
 * start left behind, so any client can label a message Home sent without
 * knowing which environment it came from.
 */
export const HOME_THREAD_ID_PREFIX = "home:";

export const isHomeThreadId = (threadId: string): boolean =>
  threadId.startsWith(HOME_THREAD_ID_PREFIX);

/**
 * Every thread Home launches has an id that starts with this, chosen before the
 * thread exists. Clients use it to leave those threads to Home instead of
 * notifying the user, with no race against Home's watch settings.
 */
export const HOME_LAUNCHED_THREAD_ID_PREFIX = "home-launched:";

export const isHomeLaunchedThreadId = (threadId: string): boolean =>
  threadId.startsWith(HOME_LAUNCHED_THREAD_ID_PREFIX);

/** Watch reports T3 Code sends into Home's thread have message ids that start with this. */
export const HOME_REPORT_MESSAGE_ID_PREFIX = "home-report:";

export const isHomeReportMessageId = (messageId: string): boolean =>
  messageId.startsWith(HOME_REPORT_MESSAGE_ID_PREFIX);

export const HomeEnableInput = Schema.Struct({ modelSelection: ModelSelection });
export type HomeEnableInput = typeof HomeEnableInput.Type;

export const HomeThreadResult = Schema.Struct({ threadId: ThreadId });
export type HomeThreadResult = typeof HomeThreadResult.Type;

export class HomeUnavailableError extends Schema.TaggedError<HomeUnavailableError>()(
  "HomeUnavailableError",
  { message: Schema.String },
) {}

// ---------------------------------------------------------------------------
// Fleet operations: what Home can do in any environment.
// ---------------------------------------------------------------------------

/** The Home thread that asked, recorded as the sender of messages it causes. */
export const FleetActor = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type FleetActor = typeof FleetActor.Type;

const environmentIdField = OrchestratorMcpEnvironmentTarget;

export const FleetProjectListInput = Schema.Struct({
  environmentId: environmentIdField,
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type FleetProjectListInput = typeof FleetProjectListInput.Type;

export const FleetProjectListResult = Schema.Struct({
  projects: Schema.Array(Project),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type FleetProjectListResult = typeof FleetProjectListResult.Type;

export const FleetThreadLaunchInput = Schema.Struct({
  environmentId: environmentIdField,
  /** Chosen by the hub, so Home's watch on the thread exists before the thread does. */
  threadId: Schema.optional(ThreadId),
  projectId: Schema.optional(ProjectId),
  scratch: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Launch without a project, in its own folder under the environment's Scratch project. Not with projectId or workspaceStrategy.",
    }),
  ),
  title: TrimmedNonEmptyString,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  workspaceStrategy: Schema.optional(
    OrchestrationV2ThreadLaunchWorkspaceStrategy.annotate({
      description:
        "Choose where this thread runs before starting its agent: worktree creates and binds a new checkout from baseRef; existing_worktree binds worktreePath; root uses the project checkout. Omitted means root, not the caller's worktree. For a PR stack use the parent branch as baseRef and startFromOrigin:false. Uncommitted changes are not copied.",
    }),
  ),
  message: Schema.optional(
    Schema.String.check(Schema.isMaxLength(120000)).annotate({
      description:
        "First task prompt, delivered after workspace preparation. Omit message and attachments to create an idle thread.",
    }),
  ),
});
export type FleetThreadLaunchInput = typeof FleetThreadLaunchInput.Type;

export const FleetThreadLaunchResult = Schema.Struct({
  threadId: ThreadId,
  /** Paste this whenever you mention the thread, so the user can click to open it. */
  link: Schema.String,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runId: Schema.NullOr(RunId),
  status: Schema.NullOr(OrchestrationV2RunStatus),
});
export type FleetThreadLaunchResult = typeof FleetThreadLaunchResult.Type;

export const FleetThreadOrganizeAction = Schema.Literals([
  "pin",
  "unpin",
  "snooze",
  "unsnooze",
  "settle",
  "unsettle",
  "archive",
  "unarchive",
  "mark_unread",
]);
export type FleetThreadOrganizeAction = typeof FleetThreadOrganizeAction.Type;

export const FleetThreadOrganizeInput = Schema.Struct({
  environmentId: environmentIdField,
  threadId: Schema.optional(ThreadId),
  action: FleetThreadOrganizeAction,
  snoozedUntil: Schema.optional(IsoDateTime),
});
export type FleetThreadOrganizeInput = typeof FleetThreadOrganizeInput.Type;

export const FleetThreadRenameInput = Schema.Struct({
  environmentId: environmentIdField,
  threadId: ThreadId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type FleetThreadRenameInput = typeof FleetThreadRenameInput.Type;

export const FleetRequestsListInput = Schema.Struct({
  environmentId: environmentIdField,
  threadId: Schema.optional(ThreadId),
});
export type FleetRequestsListInput = typeof FleetRequestsListInput.Type;

export const FleetPendingRequestKind = Schema.Literals(["question", "approval"]);
export type FleetPendingRequestKind = typeof FleetPendingRequestKind.Type;

export const FleetRequestsListResult = Schema.Struct({
  /** Pending user questions. */
  requestIds: Schema.Array(RuntimeRequestId),
  /** Pending approvals. Only Home sees these. */
  approvalRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
});
export type FleetRequestsListResult = typeof FleetRequestsListResult.Type;

export const FleetRequestTarget = Schema.Struct({
  environmentId: environmentIdField,
  threadId: Schema.optional(ThreadId),
  requestId: RuntimeRequestId,
});
export type FleetRequestTarget = typeof FleetRequestTarget.Type;

const FleetQuestion = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      value: Schema.optional(Schema.String),
    }),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  required: Schema.optional(Schema.Boolean),
});

export const FleetRequestReadResult = Schema.Struct({
  requestId: RuntimeRequestId,
  kind: Schema.optional(FleetPendingRequestKind),
  /** The questions of a user-input request; empty for an approval. */
  questions: Schema.Array(FleetQuestion),
  /** What an approval asks to do. */
  approval: Schema.optional(
    Schema.Struct({
      requestKind: ProviderRequestKind,
      prompt: Schema.NullOr(Schema.String),
      appName: Schema.NullOr(Schema.String),
      options: Schema.Array(ProviderApprovalOption),
    }),
  ),
});
export type FleetRequestReadResult = typeof FleetRequestReadResult.Type;

export const FleetRequestRespondInput = Schema.Struct({
  ...FleetRequestTarget.fields,
  answers: Schema.optional(ProviderUserInputAnswers),
  decision: Schema.optional(
    ProviderApprovalDecision.annotate({
      description: "Home only: the decision for a pending approval.",
    }),
  ),
});
export type FleetRequestRespondInput = typeof FleetRequestRespondInput.Type;

/** The providers another environment offers, for picking a model there. */
export const FleetCapabilitiesResult = Schema.Struct({
  providers: Schema.Array(OrchestratorMcpProviderCapability),
});
export type FleetCapabilitiesResult = typeof FleetCapabilitiesResult.Type;

const operation = <const Op extends string, S extends Schema.Top>(op: Op, input: S) =>
  Schema.Struct({ op: Schema.Literal(op), input });

/** One operation Home asks an environment to run, with the user's reach. */
export const FleetRequest = Schema.Union([
  operation("capabilities", Schema.Struct({ environmentId: environmentIdField })),
  operation("projects.list", FleetProjectListInput),
  operation("threads.list", OrchestratorMcpThreadListInput),
  operation("threads.read", OrchestratorMcpThreadReadInput),
  operation("threads.launch", FleetThreadLaunchInput),
  operation("threads.send", OrchestratorMcpThreadSendInput),
  operation("threads.interrupt", OrchestratorMcpThreadInterruptInput),
  operation("threads.organize", FleetThreadOrganizeInput),
  operation("threads.rename", FleetThreadRenameInput),
  operation("requests.list", FleetRequestsListInput),
  operation("requests.read", FleetRequestTarget),
  operation("requests.respond", FleetRequestRespondInput),
]);
export type FleetRequest = typeof FleetRequest.Type;
export type FleetOperation = FleetRequest["op"];

/** The result schema of each operation. Results cross the wire untyped and are decoded with these. */
export const FleetResults = {
  capabilities: FleetCapabilitiesResult,
  "projects.list": FleetProjectListResult,
  "threads.list": OrchestratorMcpThreadListResult,
  "threads.read": OrchestratorMcpThreadReadResult,
  "threads.launch": FleetThreadLaunchResult,
  "threads.send": OrchestratorMcpThreadSendResult,
  "threads.interrupt": OrchestratorMcpThreadInterruptResult,
  "threads.organize": OrchestrationV2DispatchCommandResult,
  "threads.rename": ThreadMetadataMcpUpdateResult,
  "requests.list": FleetRequestsListResult,
  "requests.read": FleetRequestReadResult,
  "requests.respond": OrchestrationV2DispatchCommandResult,
} satisfies Record<FleetOperation, Schema.Top>;
export type FleetResult<Op extends FleetOperation> = (typeof FleetResults)[Op]["Type"];
export type FleetInput<Op extends FleetOperation> = Extract<FleetRequest, { op: Op }>["input"];

/** Runs one fleet operation on the environment that receives it. */
export const FleetInvokeInput = Schema.Struct({ actor: FleetActor, request: FleetRequest });
export type FleetInvokeInput = typeof FleetInvokeInput.Type;

// ---------------------------------------------------------------------------
// Hub <-> desktop renderer relay.
// ---------------------------------------------------------------------------

export const FleetEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  connected: Schema.Boolean,
});
export type FleetEnvironment = typeof FleetEnvironment.Type;

/** A desktop renderer offering to relay Home's calls to its connections. */
export const FleetHostRegistration = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  environments: Schema.Array(FleetEnvironment),
});
export type FleetHostRegistration = typeof FleetHostRegistration.Type;

export const FleetHostRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  invoke: FleetInvokeInput,
});
export type FleetHostRequest = typeof FleetHostRequest.Type;

export const FleetHostResponse = Schema.Union([
  Schema.Struct({ requestId: TrimmedNonEmptyString, result: Schema.Unknown }),
  Schema.Struct({ requestId: TrimmedNonEmptyString, failure: OrchestratorMcpFailure }),
]);
export type FleetHostResponse = typeof FleetHostResponse.Type;

export const HomeWatchEventKind = Schema.Literals([
  "completed",
  "failed",
  "question",
  "approval",
  // The thread was settled or archived; its watch ends without waking Home.
  "ended",
]);
export type HomeWatchEventKind = typeof HomeWatchEventKind.Type;

export const HomeWatchEvent = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  threadId: ThreadId,
  title: Schema.String.check(Schema.isMaxLength(300)),
  kind: HomeWatchEventKind,
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type HomeWatchEvent = typeof HomeWatchEvent.Type;

export const HomeWatchReport = Schema.Struct({ events: Schema.Array(HomeWatchEvent) });
export type HomeWatchReport = typeof HomeWatchReport.Type;
