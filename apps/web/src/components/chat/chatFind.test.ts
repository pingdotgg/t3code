import { describe, expect, it } from "vitest";
import { buildChatFindRows, findChatFindMatches } from "./chatFind";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";

describe("chatFind", () => {
  it("indexes visible subagent card and dialog text", () => {
    const rows: MessagesTimelineRow[] = [
      {
        id: "work-row-1",
        kind: "work",
        createdAt: "2026-05-31T00:00:00.000Z",
        shouldAutoCollapse: false,
        groupedEntries: [
          {
            id: "work-entry-1",
            createdAt: "2026-05-31T00:00:00.000Z",
            label: "Subagent",
            tone: "tool",
            subagent: {
              id: "subagent-1",
              name: "acp-alpha",
              description: "Alpha read-only result",
              agentType: "explore",
              prompt: "Inspect the API surface and report back.",
              promptPreview: "Inspect the API surface and report back.",
              result: "Alpha found the relevant flow.",
              resultPreview: "Alpha found the relevant flow.",
              status: "completed",
            },
          },
        ],
      },
    ];

    const findRows = buildChatFindRows(rows);

    expect(findChatFindMatches(findRows, "Alpha read-only result")).toHaveLength(1);
    expect(findChatFindMatches(findRows, "Inspect the API surface")).toHaveLength(1);
    expect(findChatFindMatches(findRows, "Alpha found the relevant flow")).toHaveLength(1);
  });
});
