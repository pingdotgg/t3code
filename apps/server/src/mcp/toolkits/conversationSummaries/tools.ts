import {
  ConversationSummaryDescribeInput,
  ConversationSummaryExpandInput,
  ConversationSummaryExpansion,
  ConversationSummaryList,
  ConversationSummaryListInput,
  ConversationSummaryRead,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ConversationSummaries from "../../../project/conversationSummaries/ConversationSummaries.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    ConversationSummaries.ConversationSummaries,
    ThreadManagement.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};

export const ConversationSummariesToolkit = Toolkit.make(
  Tool.make("t3_conversation_summary_list", {
    ...shared,
    description:
      "List stored thread summaries (messages/tool evidence), oldest first, for long-thread recall or handoffs. Includes enabled status and last pass. query matches statement text as a literal case-insensitive substring. Follow cursor=nextCursor with the same query. Stale summaries expose no text; this never generates summaries.",
    parameters: Schema.Struct({
      ...ConversationSummaryListInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ConversationSummaryList,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_conversation_summary_describe", {
    ...shared,
    description:
      "Read a generated summary's statements, citation keys and canonical message/tool source refs with digests and optional UTF-16 ranges (end exclusive). Verify claims with t3_conversation_summary_expand. Stale summaries expose no text.",
    parameters: Schema.Struct({
      ...ConversationSummaryDescribeInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ConversationSummaryRead,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_conversation_summary_expand", {
    ...shared,
    description:
      "Read canonical source ranges; changed, removed, archived or unfinished sources are unavailable. maxChars bounds page text (default 12000, max 48000 UTF-16 units); limit bounds source count. Continue with offset=nextOffset AND textOffset=nextTextOffset even when offset repeats. null nextOffset ends paging.",
    parameters: Schema.Struct({
      ...ConversationSummaryExpandInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ConversationSummaryExpansion,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
