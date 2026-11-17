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
      "Search stored summaries across a project, optionally one thread, most relevant first. Use 1-3 distinctive terms: every query word must match (Unicode full-text terms, not substring or FTS syntax), so when nothing matches, rephrase with fewer or different terms in another call. Returns verified previews up to 1000 UTF-16 units each; limit defaults to 10, maximum 20. Read full statements with t3_conversation_summary_describe. Expand a hit with t3_conversation_summary_expand using its projectId, threadId and id as summaryId; recurse through child summaries for original evidence. Follow nextCursor with the same query and scope, even after an empty page. Never generates summaries.",
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
      "List stored thread summaries (messages/tool evidence), oldest first, with enabled status and last pass. query is a literal case-insensitive substring of statement text. Follow cursor=nextCursor with the same query. Never generates summaries.",
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
      "Read a summary's statements, citation keys and sources: message/tool refs with digests and optional UTF-16 ranges (end exclusive), or a roll-up's child summary ids. Verify claims with t3_conversation_summary_expand. Stale summaries expose no text.",
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
      "Read original messages/tool output, or a roll-up's child summaries; expand a cited child for original evidence. Once that evidence answers the question, no further thread read is needed. Changed, removed, archived or unfinished sources are unavailable. maxChars (default 12000, max 48000 UTF-16 units) bounds page text; limit bounds sources. Continue with offset=nextOffset AND textOffset=nextTextOffset even when offset repeats. null nextOffset ends paging.",
    parameters: Schema.Struct({
      ...ConversationSummaryExpandInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ConversationSummaryExpansion,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
