/**
 * Fork: roadmap tools. Agents read and change the roadmap through the same
 * service the clients use, acting as their own thread.
 */
import {
  IsoDate,
  IsoDateTime,
  McpCapabilityUnavailableError,
  NonNegativeInt,
  OrchestratorMcpFailure,
  RoadmapActor,
  RoadmapArea,
  RoadmapErrorCode,
  RoadmapItemId,
  RoadmapItemState,
  RoadmapItemType,
  RoadmapPriority,
  RoadmapUnit,
  RoadmapWorkItem,
  ThreadId,
  TrimmedNonEmptyString,
} from "@lathe/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as RoadmapGitHubSync from "../../../fork/roadmap/RoadmapGitHubSync.ts";
import * as RoadmapService from "../../../fork/roadmap/RoadmapService.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  // The access gate reads the calling thread through it.
  ThreadManagementService.ThreadManagementService,
  RoadmapService.RoadmapService,
  // Area settings decide the unit and working days behind forecasts.
  ServerSettingsService,
];

const NonNegativeNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveNumber = Schema.Finite.check(Schema.isGreaterThan(0));

const RoadmapForecastStatus = Schema.Literals(["on-track", "at-risk", "late", "no-forecast"]);

const ClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
  description: "Stable idempotency key to reuse when retrying this mutation.",
});

const ItemIdOrAttached = RoadmapItemId.annotate({
  description: "The work item. Omit for the item this thread is attached to.",
});

export const RoadmapListInput = Schema.Struct({
  area: Schema.optional(
    RoadmapArea.annotate({ description: "Only items in this area, inherited areas included." }),
  ),
  type: Schema.optional(RoadmapItemType.annotate({ description: "Only items of this type." })),
  state: Schema.optional(RoadmapItemState.annotate({ description: "Only items in this state." })),
  underItemId: Schema.optional(
    RoadmapItemId.annotate({ description: "Only items below this one in the tree." }),
  ),
});
export type RoadmapListInput = typeof RoadmapListInput.Type;

export const RoadmapReadInput = Schema.Struct({ itemId: Schema.optional(ItemIdOrAttached) });
export type RoadmapReadInput = typeof RoadmapReadInput.Type;

export const RoadmapCreateInput = Schema.Struct({
  type: RoadmapItemType,
  title: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String.annotate({ description: "Markdown." })),
  parentId: Schema.optional(
    RoadmapItemId.annotate({ description: "The parent item. Omit for a top-level item." }),
  ),
  priority: Schema.optional(
    RoadmapPriority.annotate({ description: "Omit to inherit the parent's priority." }),
  ),
  area: Schema.optional(
    RoadmapArea.annotate({ description: "Omit to inherit the parent's area." }),
  ),
  state: Schema.optional(RoadmapItemState.annotate({ description: "Defaults to backlog." })),
  dueDate: Schema.optional(IsoDate.annotate({ description: "A calendar date, YYYY-MM-DD." })),
  estimate: Schema.optional(NonNegativeNumber),
  criteria: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).annotate({ description: "Acceptance criteria, in order." }),
  ),
  attachCaller: Schema.optional(
    Schema.Boolean.annotate({ description: "Also attach this thread to the new item." }),
  ),
  clientRequestId: Schema.optional(ClientRequestId),
});
export type RoadmapCreateInput = typeof RoadmapCreateInput.Type;

export const RoadmapUpdateInput = Schema.Struct({
  itemId: Schema.optional(ItemIdOrAttached),
  type: Schema.optional(RoadmapItemType),
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.String),
  state: Schema.optional(
    RoadmapItemState.annotate({
      description: "done is refused while any acceptance criterion is unticked.",
    }),
  ),
  priority: Schema.optional(
    Schema.NullOr(RoadmapPriority).annotate({ description: "null inherits from the parent." }),
  ),
  area: Schema.optional(
    Schema.NullOr(RoadmapArea).annotate({ description: "null inherits from the parent." }),
  ),
  dueDate: Schema.optional(Schema.NullOr(IsoDate).annotate({ description: "null clears it." })),
  startDate: Schema.optional(Schema.NullOr(IsoDate).annotate({ description: "null clears it." })),
  estimate: Schema.optional(
    Schema.NullOr(NonNegativeNumber).annotate({ description: "null clears it." }),
  ),
  clientRequestId: Schema.optional(ClientRequestId),
});
export type RoadmapUpdateInput = typeof RoadmapUpdateInput.Type;

export const RoadmapCriterionTickInput = Schema.Struct({
  itemId: Schema.optional(ItemIdOrAttached),
  criterionId: TrimmedNonEmptyString.annotate({
    description: "The criterion id from lathe_roadmap_read.",
  }),
  ticked: Schema.Boolean.annotate({ description: "false unticks it." }),
  evidence: Schema.optional(
    Schema.String.annotate({
      description: "What shows the criterion is met: a test, a commit, a file, a PR.",
    }),
  ),
  clientRequestId: Schema.optional(ClientRequestId),
});
export type RoadmapCriterionTickInput = typeof RoadmapCriterionTickInput.Type;

export const RoadmapAttachInput = Schema.Struct({
  itemId: RoadmapItemId,
  threadId: Schema.optional(
    ThreadId.annotate({ description: "A thread in this environment. Omit for this thread." }),
  ),
  clientRequestId: Schema.optional(ClientRequestId),
});
export type RoadmapAttachInput = typeof RoadmapAttachInput.Type;

export const RoadmapDetachInput = Schema.Struct({
  itemId: Schema.optional(
    RoadmapItemId.annotate({ description: "Omit for the item the thread is attached to." }),
  ),
  threadId: Schema.optional(
    ThreadId.annotate({ description: "A thread in this environment. Omit for this thread." }),
  ),
  clientRequestId: Schema.optional(ClientRequestId),
});
export type RoadmapDetachInput = typeof RoadmapDetachInput.Type;

export const RoadmapLinkBlockerInput = Schema.Struct({
  itemId: Schema.optional(ItemIdOrAttached),
  blockedById: RoadmapItemId.annotate({ description: "The item that must finish first." }),
  linked: Schema.Boolean.annotate({ description: "false removes the link." }),
  clientRequestId: Schema.optional(ClientRequestId),
});
export type RoadmapLinkBlockerInput = typeof RoadmapLinkBlockerInput.Type;

export const RoadmapLogHoursInput = Schema.Struct({
  itemId: Schema.optional(ItemIdOrAttached),
  hours: PositiveNumber.annotate({ description: "Hours spent, such as 1.5." }),
  note: Schema.optional(Schema.String.annotate({ description: "What the time went on." })),
  clientRequestId: Schema.optional(ClientRequestId),
});
export type RoadmapLogHoursInput = typeof RoadmapLogHoursInput.Type;

export const RoadmapAddNoteInput = Schema.Struct({
  itemId: Schema.optional(ItemIdOrAttached),
  text: TrimmedNonEmptyString.annotate({
    description: "What moved, in a sentence or two: what was done, found or decided.",
  }),
  clientRequestId: Schema.optional(ClientRequestId),
});
export type RoadmapAddNoteInput = typeof RoadmapAddNoteInput.Type;

export const RoadmapImportIssueToolInput = Schema.Struct({
  url: TrimmedNonEmptyString.annotate({
    description: "The GitHub issue's URL, such as https://github.com/owner/repo/issues/12.",
  }),
  parentId: Schema.optional(
    RoadmapItemId.annotate({ description: "Put the issue under this work item." }),
  ),
  area: Schema.optional(
    RoadmapArea.annotate({
      description:
        "Area for a top-level issue. The area its repository's GitHub account maps to wins.",
    }),
  ),
});
export type RoadmapImportIssueToolInput = typeof RoadmapImportIssueToolInput.Type;

export const RoadmapImportIssueToolResult = Schema.Struct({
  itemId: RoadmapItemId,
  imported: NonNegativeInt.annotate({
    description: "Items created, the issue's sub-issues included; 0 when it was already imported.",
  }),
});
export type RoadmapImportIssueToolResult = typeof RoadmapImportIssueToolResult.Type;

export const RoadmapLinkPullRequestInput = Schema.Struct({
  itemId: Schema.optional(ItemIdOrAttached),
  url: TrimmedNonEmptyString.annotate({
    description: "The pull request's URL, such as https://github.com/owner/repo/pull/7.",
  }),
  clientRequestId: Schema.optional(ClientRequestId),
});
export type RoadmapLinkPullRequestInput = typeof RoadmapLinkPullRequestInput.Type;

/** A roadmap refusal, with its code first in the message the agent reads. */
export class RoadmapToolFailure extends Schema.TaggedError<RoadmapToolFailure>()(
  "RoadmapToolFailure",
  {
    code: Schema.Literals([
      ...RoadmapErrorCode.literals,
      /** Agents may not mark an item done while a criterion is open. */
      "open_criteria",
    ]),
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `${this.code}: ${this.reason}`;
  }
}

export const RoadmapToolError = Schema.Union([
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
  RoadmapToolFailure,
]);
export type RoadmapToolError = typeof RoadmapToolError.Type;

export const RoadmapListEntry = Schema.Struct({
  id: RoadmapItemId,
  type: RoadmapItemType,
  title: Schema.String,
  state: RoadmapItemState,
  priority: RoadmapPriority.annotate({ description: "Effective priority, inherited if unset." }),
  area: RoadmapArea.annotate({ description: "Effective area, inherited if unset." }),
  parentId: Schema.NullOr(RoadmapItemId),
  dueDate: Schema.NullOr(IsoDate),
  criteriaTicked: NonNegativeInt,
  criteriaTotal: NonNegativeInt,
  attachedThreads: NonNegativeInt,
  needsReview: Schema.Boolean,
  focused: Schema.Boolean.annotate({
    description: "In the user's focus set, the working set the Outline can narrow to.",
  }),
  forecast: RoadmapForecastStatus.annotate({
    description:
      "no-forecast when the item is done, has no estimate to count, or its area has under five finished samples.",
  }),
});
export type RoadmapListEntry = typeof RoadmapListEntry.Type;

export const RoadmapListResult = Schema.Struct({ items: Schema.Array(RoadmapListEntry) });
export type RoadmapListResult = typeof RoadmapListResult.Type;

const ItemSummary = Schema.Struct({
  id: RoadmapItemId,
  type: RoadmapItemType,
  title: Schema.String,
});

export const RoadmapReadResult = Schema.Struct({
  item: RoadmapWorkItem,
  effectivePriority: RoadmapPriority,
  effectiveArea: RoadmapArea,
  parents: Schema.Array(ItemSummary).annotate({ description: "Ancestors, top-level first." }),
  blockedBy: Schema.Array(Schema.Struct({ ...ItemSummary.fields, state: RoadmapItemState })),
  history: Schema.Array(
    Schema.Struct({
      sequence: NonNegativeInt,
      type: Schema.String,
      actor: RoadmapActor,
      occurredAt: IsoDateTime,
    }),
  ).annotate({ description: "The latest changes, oldest first." }),
  unit: RoadmapUnit.annotate({
    description: "What the item's area counts progress in: burned, remaining and velocity use it.",
  }),
  burned: NonNegativeNumber,
  remaining: Schema.NullOr(NonNegativeNumber).annotate({
    description: "null without an estimate to burn against; 0 once done.",
  }),
  velocity: Schema.NullOr(
    Schema.Struct({
      perDay: NonNegativeNumber.annotate({ description: "Units finished per working day." }),
      sampleSize: NonNegativeInt,
    }),
  ).annotate({ description: "The area's pace; null under five finished samples." }),
  forecast: Schema.Struct({
    status: RoadmapForecastStatus,
    projected: Schema.NullOr(IsoDate).annotate({
      description: "When the remaining work lands at the area's velocity, as a UTC date.",
    }),
  }),
});
export type RoadmapReadResult = typeof RoadmapReadResult.Type;

const RoadmapApplied = Schema.Struct({
  itemId: RoadmapItemId,
  sequence: NonNegativeInt,
});

const RoadmapQueued = Schema.Struct({
  itemId: RoadmapItemId,
  queued: Schema.Literal(true).annotate({
    description:
      "The roadmap home could not be reached, so the change waits in this environment's queue and is sent, in order, once it can be.",
  }),
});

export const RoadmapChangeResult = Schema.Union([RoadmapApplied, RoadmapQueued]);
export type RoadmapChangeResult = typeof RoadmapChangeResult.Type;

export const RoadmapLogHoursResult = Schema.Union([
  Schema.Struct({
    ...RoadmapApplied.fields,
    entryId: Schema.String,
    totalHours: NonNegativeNumber.annotate({
      description: "Every hour logged against the item so far.",
    }),
  }),
  Schema.Struct({ ...RoadmapQueued.fields, entryId: Schema.String }),
]);
export type RoadmapLogHoursResult = typeof RoadmapLogHoursResult.Type;

export const RoadmapAddNoteResult = Schema.Union([
  Schema.Struct({ ...RoadmapApplied.fields, noteId: Schema.String }),
  Schema.Struct({ ...RoadmapQueued.fields, noteId: Schema.String }),
]);
export type RoadmapAddNoteResult = typeof RoadmapAddNoteResult.Type;

// Tools that act as the calling thread are hidden from outside clients, which have none.
const ListTool = Tool.make("lathe_roadmap_list", {
  description:
    "List the Lathe roadmap's work items as compact rows with their forecast status, in tree order. Filter by area, type, state, or a subtree.",
  parameters: RoadmapListInput,
  success: RoadmapListResult,
  failure: RoadmapToolError,
  dependencies,
})
  .annotate(Tool.Title, "List roadmap work items")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ReadTool = Tool.make("lathe_roadmap_read", {
  description:
    "Read one roadmap work item with its acceptance criteria and their ids, blockers, attached threads, parents, latest changes, and its forecast, progress and velocity in the area's unit. Omit itemId for the item this thread is attached to.",
  parameters: RoadmapReadInput,
  success: RoadmapReadResult,
  failure: RoadmapToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a roadmap work item")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

// Every change tool is idempotent: a repeated clientRequestId replays the first outcome.
const CreateTool = Tool.make("lathe_roadmap_create", {
  description:
    "Create a roadmap work item, marked for the user's review. Set attachCaller to attach this thread to it.",
  parameters: RoadmapCreateInput,
  success: RoadmapChangeResult,
  failure: RoadmapToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create a roadmap work item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const UpdateTool = Tool.make("lathe_roadmap_update", {
  description:
    "Change a roadmap work item's fields. Omit itemId for the item this thread is attached to. Setting state to done is refused while any acceptance criterion is unticked.",
  parameters: RoadmapUpdateInput,
  success: RoadmapChangeResult,
  failure: RoadmapToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update a roadmap work item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const CriterionTickTool = Tool.make("lathe_roadmap_criterion_tick", {
  description:
    "Tick or untick one acceptance criterion of a roadmap work item. Give evidence when ticking. Omit itemId for the item this thread is attached to.",
  parameters: RoadmapCriterionTickInput,
  success: RoadmapChangeResult,
  failure: RoadmapToolError,
  dependencies,
})
  .annotate(Tool.Title, "Tick an acceptance criterion")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const AttachTool = Tool.make("lathe_roadmap_attach", {
  description:
    "Attach this thread, or a named thread in this environment, to a roadmap work item. A thread is attached to one item at a time, so detach it first to move it.",
  parameters: RoadmapAttachInput,
  success: RoadmapChangeResult,
  failure: RoadmapToolError,
  dependencies,
})
  .annotate(Tool.Title, "Attach a thread to a work item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DetachTool = Tool.make("lathe_roadmap_detach", {
  description:
    "Detach this thread, or a named thread in this environment, from its roadmap work item.",
  parameters: RoadmapDetachInput,
  success: RoadmapChangeResult,
  failure: RoadmapToolError,
  dependencies,
})
  .annotate(Tool.Title, "Detach a thread from a work item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const LinkBlockerTool = Tool.make("lathe_roadmap_link_blocker", {
  description:
    "Record that a roadmap work item is blocked by another, or remove that link with linked=false. Omit itemId for the item this thread is attached to.",
  parameters: RoadmapLinkBlockerInput,
  success: RoadmapChangeResult,
  failure: RoadmapToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link a roadmap blocker")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const LogHoursTool = Tool.make("lathe_roadmap_log_hours", {
  description:
    "Log hours spent on a roadmap work item. Omit itemId for the item this thread is attached to. Reuse clientRequestId when retrying so the hours are logged once.",
  parameters: RoadmapLogHoursInput,
  success: RoadmapLogHoursResult,
  failure: RoadmapToolError,
  dependencies,
})
  .annotate(Tool.Title, "Log hours on a work item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const AddNoteTool = Tool.make("lathe_roadmap_add_note", {
  description:
    "Add a progress note to a roadmap work item, shown on its card for the user. Omit itemId for the item this thread is attached to. Reuse clientRequestId when retrying so the note is added once.",
  parameters: RoadmapAddNoteInput,
  success: RoadmapAddNoteResult,
  failure: RoadmapToolError,
  dependencies,
})
  .annotate(Tool.Title, "Add a progress note to a work item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ImportIssueTool = Tool.make("lathe_roadmap_import_issue", {
  description:
    "Import a GitHub issue and its sub-issues as roadmap work items, kept in sync with GitHub from then on. Runs on the roadmap home with its GitHub logins. An issue already imported returns its item.",
  parameters: RoadmapImportIssueToolInput,
  success: RoadmapImportIssueToolResult,
  failure: RoadmapToolError,
  dependencies: [...dependencies, RoadmapGitHubSync.RoadmapGitHubSync],
})
  .annotate(Tool.Title, "Import a GitHub issue to the roadmap")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const LinkPullRequestTool = Tool.make("lathe_roadmap_link_pull_request", {
  description:
    "Link a pull request to a roadmap feature, story, bug or support ticket, so its card shows the pull request. Omit itemId for the item this thread is attached to.",
  parameters: RoadmapLinkPullRequestInput,
  success: RoadmapChangeResult,
  failure: RoadmapToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link a pull request to a work item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const RoadmapToolkit = Toolkit.make(
  ListTool,
  ReadTool,
  CreateTool,
  UpdateTool,
  CriterionTickTool,
  AttachTool,
  DetachTool,
  LinkBlockerTool,
  LogHoursTool,
  AddNoteTool,
  ImportIssueTool,
  LinkPullRequestTool,
);
