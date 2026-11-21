import {
  IssueAutomationAction,
  IssueAutomationError,
  IssueTrackerKind,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([
    OrchestratorMcpFailure,
    McpCapabilityUnavailableError,
    IssueAutomationError,
  ]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

/** What both tools return: what Settings shows for the tracker, and for `containerId` its statuses. */
export const IssueStatusRulesResult = Schema.Struct({
  rules: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      enabled: Schema.Boolean,
      workspace: Schema.String,
      containerId: Schema.String,
      containerName: Schema.String,
      /** Status id to action. */
      mappings: Schema.Record(Schema.String, IssueAutomationAction),
      /** The rule's last status read since the server started, and why it failed. */
      checkedAt: Schema.NullOr(Schema.String),
      error: Schema.NullOr(Schema.String),
    }),
  ),
  /** The teams or boards the connected account reaches. */
  containers: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  /** `containerId`'s statuses in workflow order, and what each one does to a thread. */
  statuses: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      action: Schema.NullOr(IssueAutomationAction),
    }),
  ),
  /** Why containers or statuses could not be read from the tracker. */
  error: Schema.optional(Schema.String),
});
export type IssueStatusRulesResult = typeof IssueStatusRulesResult.Type;

const ListIssueStatusRulesTool = Tool.make("list_issue_status_rules", {
  ...shared,
  description:
    "List a tracker's (such as linear) teams and its rules that wake, snooze or settle threads when linked issues change status. containerId adds a team's statuses.",
  parameters: Schema.Struct({
    tracker: IssueTrackerKind,
    containerId: Schema.optional(TrimmedNonEmptyString),
  }),
  success: IssueStatusRulesResult,
})
  .annotate(Tool.Title, "List issue status rules")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const SetIssueStatusRuleTool = Tool.make("set_issue_status_rule", {
  ...shared,
  description:
    "Create, change or remove a team's issue status rule, as in Settings. Needs a full-access or default caller.",
  parameters: Schema.Struct({
    tracker: IssueTrackerKind,
    containerId: TrimmedNonEmptyString,
    statuses: Schema.optional(
      Schema.Record(TrimmedNonEmptyString, Schema.NullOr(IssueAutomationAction)).annotate({
        description: "Status name to action; null clears it. Others are kept.",
      }),
    ),
    enabled: Schema.optional(Schema.Boolean),
    remove: Schema.optional(Schema.Boolean),
  }),
  success: IssueStatusRulesResult,
})
  .annotate(Tool.Title, "Set issue status rule")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const IssueRulesToolkit = Toolkit.make(ListIssueStatusRulesTool, SetIssueStatusRuleTool);
