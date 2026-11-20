import {
  ConversationSummaryDescribeInput,
  ConversationSummaryExpandInput,
  ConversationSummaryExpansion,
  ConversationSummaryList,
  ConversationSummaryListInput,
  ConversationSummaryRead,
  ConversationSummarySearch,
  ConversationSummarySearchInput,
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
  Tool.make("t3_conversation_summary_search", {
    ...shared,
    description:
      "Search stored project summaries by relevance, optionally per thread. Use 1-3 distinctive full-text words (all must match; no substring/FTS syntax); rephrase if empty. Verified previews: up to 1000 UTF-16 units; limit 10 by default, max 20. Use t3_conversation_summary_describe for full statements, t3_conversation_summary_expand with projectId/threadId/id as summaryId and recurse into children for evidence. Follow nextCursor with unchanged query/scope even after empty pages. Never generates summaries.",
    parameters: Schema.Struct({
      ...ConversationSummarySearchInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ConversationSummarySearch,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_conversation_summary_list", {
    ...shared,
    description:
      "List stored message/tool summaries oldest first, with enabled status and last pass. query is a case-insensitive literal substring of statement text; page with nextCursor and the same query. Never generates summaries.",
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
      "Read statements, citation keys and sources (message/tool refs with digests and optional end-exclusive UTF-16 ranges, or child summary IDs). Verify with t3_conversation_summary_expand. Stale summaries have no text.",
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
      "Read original messages/tool output or roll-up children. Expand cited children to verify; stop when evidence answers the question. Changed, removed, archived or unfinished sources are unavailable. maxChars bounds page text (12,000 default, 48,000 max UTF-16 units); limit bounds sources. Page with offset=nextOffset AND textOffset=nextTextOffset even if offset repeats; null nextOffset ends paging.",
    parameters: Schema.Struct({
      ...ConversationSummaryExpandInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ConversationSummaryExpansion,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
