import { Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";

import { TrimmedNonEmptyString } from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";
import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";

/**
 * Input shapes mirror the legacy `delegate_work` JSON contract in
 * `apps/server/src/mcpServer.ts` field for field (descriptions included),
 * so the advertised contract stays identical. The legacy implementation
 * remains the validation authority and re-checks everything at runtime.
 */
const DelegationFollowUp = Schema.Literals(["automatic", "notify-only"]);
const DelegationWait = Schema.Literals(["all", "any", "none"]);
const DelegationReasoning = Schema.Literals(["low", "medium", "high", "xhigh"]);

const DelegationWorkspace = Schema.Struct({
  mode: Schema.Literal("isolated"),
  branch: Schema.String.check(Schema.isMinLength(1)),
  path: Schema.String.check(Schema.isMinLength(1)),
  baseRef: Schema.optional(Schema.String),
});

const DelegationPromptTemplate = Schema.Struct({
  blocks: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
  repository: Schema.optional(
    Schema.Struct({
      context: Schema.optional(Schema.String),
      instructionFiles: Schema.optional(
        Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
      ),
    }),
  ),
  validation: Schema.optional(
    Schema.Struct({
      commands: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
        Schema.isMinLength(1),
      ),
      scenarios: Schema.optional(
        Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
      ),
      evidence: Schema.optional(
        Schema.Array(Schema.Literals(["screenshot", "recording"])).check(Schema.isMinLength(1)),
      ),
      owner: Schema.optional(Schema.Literals(["child", "parent"])),
    }),
  ),
  commit: Schema.optional(
    Schema.Struct({
      requirements: Schema.optional(
        Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
      ),
    }),
  ),
  pullRequest: Schema.optional(
    Schema.Struct({
      requirements: Schema.optional(
        Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
      ),
    }),
  ),
  reporting: Schema.optional(
    Schema.Struct({
      items: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
    }),
  ),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  additions: Schema.optional(
    Schema.Record(Schema.String, Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
  ),
});

const DelegationDefaults = Schema.Struct({
  followUp: Schema.optional(DelegationFollowUp),
  project: Schema.optional(Schema.String),
  promptTemplate: Schema.optional(DelegationPromptTemplate),
  model: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  reasoning: Schema.optional(DelegationReasoning),
  dryRun: Schema.optional(Schema.Boolean),
});

const DelegationChild = Schema.Struct({
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  project: Schema.optional(Schema.String),
  promptTemplate: Schema.optional(DelegationPromptTemplate),
  model: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  reasoning: Schema.optional(DelegationReasoning),
  dryRun: Schema.optional(Schema.Boolean),
  followUp: Schema.optional(DelegationFollowUp),
  workspace: Schema.optional(DelegationWorkspace),
});

export const DelegateWorkToolInput = Schema.Struct({
  defaults: Schema.optional(DelegationDefaults),
  children: Schema.Array(DelegationChild).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  concurrency: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(4)),
  ),
  wait: Schema.optional(DelegationWait),
});
export type DelegateWorkToolInput = typeof DelegateWorkToolInput.Type;

export class DelegationToolError extends Schema.TaggedErrorClass<DelegationToolError>()(
  "DelegationToolError",
  { message: Schema.String },
) {}

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery,
  ProviderSessionDirectory,
  ServerConfig,
  ServerSettingsService,
];

export const DelegateWorkTool = Tool.make("delegate_work", {
  description:
    "Canonical delegation tool for one or many helper threads. Supply children with only title and prompt; shared project, model, reasoning, prompt template, follow-up policy, and dry-run settings belong in defaults and may be overridden per child. Project defaults to the authenticated parent workspace; model defaults to the settings delegated-thread model (factory Copilot gpt-6-luna). For automatic children, wait selects all, any, or no batch wait; the default is all when more than one automatic child is created and none for one child or notify-only work. The wait is installed atomically with child creation and revised to include only created assignments before this tool returns. T3 preserves input order, rejects workspace collisions before mutation, and returns indexed outcomes including partial failures.",
  parameters: DelegateWorkToolInput,
  success: Schema.String,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delegate work to helper threads")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const DelegationToolkit = Toolkit.make(DelegateWorkTool);
