import { OrchestratorMcpFailure, type ConversationSummaryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ConversationSummaries from "../../../project/conversationSummaries/ConversationSummaries.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { ConversationSummariesToolkit } from "./tools.ts";

const failure = (error: ConversationSummaryError | OrchestratorMcpFailure) =>
  error._tag === "ConversationSummaryError"
    ? new OrchestratorMcpFailure({
        code: error.reason === "storage" ? "orchestration_error" : "invalid_request",
        message: error.message,
      })
    : error;
const access = readCaller().pipe(Effect.andThen(ConversationSummaries.ConversationSummaries));

export const layer = McpToolAccess.toLayer(ConversationSummariesToolkit, {
  t3_conversation_summary_search: McpToolAccess.reads((input) =>
    Effect.flatMap(access, (service) => service.search(input)).pipe(Effect.mapError(failure)),
  ),
  t3_conversation_summary_list: McpToolAccess.reads((input) =>
    Effect.flatMap(access, (service) => service.list(input)).pipe(Effect.mapError(failure)),
  ),
  t3_conversation_summary_describe: McpToolAccess.reads((input) =>
    Effect.flatMap(access, (service) => service.describe(input)).pipe(Effect.mapError(failure)),
  ),
  t3_conversation_summary_expand: McpToolAccess.reads((input) =>
    Effect.flatMap(access, (service) => service.expand(input)).pipe(Effect.mapError(failure)),
  ),
});
