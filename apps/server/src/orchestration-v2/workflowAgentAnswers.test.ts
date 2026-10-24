import { describe, expect, it } from "vite-plus/test";

import { mergeWorkflowAgentMetadata } from "./workflowAgentAnswers.ts";

describe("mergeWorkflowAgentMetadata", () => {
  it("keeps effort and speed across reads of a split assistant message", () => {
    const metadata = mergeWorkflowAgentMetadata([
      {
        type: "assistant",
        effort: "xhigh",
        message: { id: "a", content: [], usage: { speed: "standard" } },
      },
    ]);
    expect(metadata).toEqual({ messageId: "a", effort: "xhigh", speed: "standard" });
    expect(
      mergeWorkflowAgentMetadata(
        [{ type: "assistant", message: { id: "a", content: [{ type: "text", text: "Done" }] } }],
        metadata,
      ),
    ).toEqual(metadata);
    expect(mergeWorkflowAgentMetadata([], metadata)).toEqual(metadata);
  });

  it("ignores bookkeeping and API errors without clearing prior metadata", () => {
    const metadata = { messageId: "a", effort: "max", speed: "standard" };
    expect(
      mergeWorkflowAgentMetadata(
        [
          { type: "user", effort: "high", message: { usage: { speed: "fast" } } },
          { type: "assistant", isMeta: true, effort: "high" },
          { type: "assistant", isApiErrorMessage: true, message: { id: "error" } },
          { type: "assistant", effort: 1, message: { id: "a", usage: { speed: false } } },
        ],
        metadata,
      ),
    ).toEqual(metadata);
  });

  it.each(["b", undefined])("clears omitted metadata for a new response with id %s", (id) => {
    expect(
      mergeWorkflowAgentMetadata([{ type: "assistant", message: { id, content: [] } }], {
        messageId: "a",
        effort: "max",
        speed: "standard",
      }),
    ).toEqual(id === undefined ? {} : { messageId: id });
  });
});
