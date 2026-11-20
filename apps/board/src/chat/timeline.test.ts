import { describe, expect, it } from "vite-plus/test";

import { type ChatItem, isRunLive, timelineRows } from "./timeline";

const source = (
  items: ReadonlyArray<ChatItem>,
  runs: ReadonlyArray<{ id: string; status: string }> = [],
  messages: ReadonlyArray<{ id: string; text: string }> = [],
) => ({ runs, messages, items });

const tool = (id: string, label: string, running = false): ChatItem => ({
  kind: "tool",
  id,
  label,
  running,
  failed: false,
});

describe("the chat rows of a thread", () => {
  it("Given a brief the engine left out, when the rows are built, then its text comes from the thread's messages", () => {
    const rows = timelineRows(
      source(
        [{ kind: "user", id: "i1", messageId: "m1", text: "", textOmitted: true }],
        [],
        [{ id: "m1", text: "You are this board's orchestrator" }],
      ),
    );
    expect(rows).toEqual([{ kind: "user", id: "i1", text: "You are this board's orchestrator" }]);
  });

  it("Given tool calls between two replies, when the rows are built, then each stretch folds into one work row", () => {
    const rows = timelineRows(
      source([
        {
          kind: "assistant",
          id: "a1",
          messageId: "m1",
          text: "Planning.",
          textOmitted: false,
          streaming: false,
        },
        tool("t1", "delegate_task"),
        tool("t2", "$ ls .agentboard", true),
        {
          kind: "assistant",
          id: "a2",
          messageId: "m2",
          text: "Done.",
          textOmitted: false,
          streaming: true,
        },
      ]),
    );
    expect(rows.map((row) => row.kind)).toEqual(["assistant", "work", "assistant"]);
    expect(rows[1]).toEqual({
      kind: "work",
      id: "t1",
      steps: [
        { id: "t1", label: "delegate_task", running: false, failed: false },
        { id: "t2", label: "$ ls .agentboard", running: true, failed: false },
      ],
    });
  });

  it("Given an empty reply that is still streaming, when the rows are built, then the row is kept for its first token", () => {
    const rows = timelineRows(
      source([
        {
          kind: "assistant",
          id: "a1",
          messageId: "m1",
          text: "",
          textOmitted: false,
          streaming: true,
        },
      ]),
    );
    expect(rows).toEqual([{ kind: "assistant", id: "a1", text: "", streaming: true }]);
  });

  it("Given an empty reply that has finished, when the rows are built, then it is dropped", () => {
    const rows = timelineRows(
      source([
        {
          kind: "assistant",
          id: "a1",
          messageId: "m1",
          text: "",
          textOmitted: false,
          streaming: false,
        },
      ]),
    );
    expect(rows).toEqual([]);
  });

  it("Given an interrupted run, when the rows are built, then the last row says Stopped", () => {
    const rows = timelineRows(source([], [{ id: "r1", status: "interrupted" }]));
    expect(rows).toEqual([{ kind: "notice", id: "r1:stopped", text: "Stopped", error: false }]);
  });

  it("Given a failed turn, when the rows are built, then the error shows as an error notice", () => {
    const rows = timelineRows(
      source([{ kind: "notice", id: "e1", text: "Claude gave up.", error: true }]),
    );
    expect(rows).toEqual([{ kind: "notice", id: "e1", text: "Claude gave up.", error: true }]);
  });
});

describe("whether a run is live", () => {
  it.each([
    ["running", true],
    ["starting", true],
    ["completed", false],
    ["interrupted", false],
  ])("Given a latest run that is %s, when it is read, then live is %s", (status, live) => {
    expect(isRunLive({ runs: [{ id: "r1", status }] })).toBe(live);
  });

  it("Given no run, when it is read, then it is not live", () => {
    expect(isRunLive({ runs: [] })).toBe(false);
  });
});
