import type { OrchestrationV2WorkflowAgent } from "@t3tools/contracts";

import { field, text } from "./unknownField.ts";

export type WorkflowAgentMetadata = Pick<OrchestrationV2WorkflowAgent, "effort" | "speed"> & {
  readonly messageId?: string;
};

export function mergeWorkflowAgentMetadata(
  lines: ReadonlyArray<unknown>,
  previous: WorkflowAgentMetadata = {},
): WorkflowAgentMetadata {
  let metadata = previous;
  for (const entry of lines) {
    if (
      field(entry, "type") !== "assistant" ||
      field(entry, "isMeta") === true ||
      field(entry, "isApiErrorMessage") === true
    )
      continue;
    const message = field(entry, "message");
    const messageId = text(field(message, "id"));
    const effort = text(field(entry, "effort"));
    const speed = text(field(field(message, "usage"), "speed"));
    metadata = {
      ...(messageId !== undefined && messageId === metadata.messageId ? metadata : {}),
      ...(messageId === undefined ? {} : { messageId }),
      ...(effort === undefined ? {} : { effort }),
      ...(speed === undefined ? {} : { speed }),
    };
  }
  return metadata;
}
