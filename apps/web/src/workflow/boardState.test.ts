import { describe, expect, it } from "vite-plus/test";

import { applyBoardStreamItem, emptyBoardState } from "./boardState.ts";

describe("boardState", () => {
  it("applies a snapshot then a ticket delta", () => {
    let state = applyBoardStreamItem(emptyBoardState, {
      kind: "snapshot",
      snapshot: {
        projectId: "project-1",
        board: {
          boardId: "b-1",
          name: "Delivery",
          lanes: [
            { key: "backlog", name: "Backlog", entry: "manual", pipelineStepCount: 0, wipLimit: 1 },
            { key: "done", name: "Done", entry: "manual", pipelineStepCount: 0, terminal: true },
          ],
        },
        tickets: [
          {
            ticketId: "t-1",
            boardId: "b-1",
            title: "X",
            description: "Snapshot description",
            currentLaneKey: "backlog",
            status: "idle",
          },
          {
            ticketId: "t-queued",
            boardId: "b-1",
            title: "Queued",
            currentLaneKey: "backlog",
            queuedAt: "2026-06-07T00:00:00.000Z",
            status: "queued",
          },
        ],
      },
    } as never);
    expect(state.projectId).toBe("project-1");
    expect(state.ticketIds).toEqual(["t-1", "t-queued"]);
    expect(state.lanes[0]?.wipLimit).toBe(1);
    expect(state.lanes[0]?.admittedTicketIds).toEqual(["t-1"]);
    expect(state.lanes[0]?.queuedTicketIds).toEqual(["t-queued"]);
    expect(state.ticketById["t-1"]?.description).toBe("Snapshot description");
    expect(state.ticketById["t-queued"]?.queuedAt).toBe("2026-06-07T00:00:00.000Z");

    state = applyBoardStreamItem(state, {
      kind: "ticket",
      ticket: {
        ticketId: "t-queued",
        boardId: "b-1",
        title: "Queued",
        description: "",
        currentLaneKey: "done",
        status: "done",
      },
    } as never);
    expect(state.ticketById["t-queued"]?.currentLaneKey).toBe("done");
    expect(state.ticketById["t-queued"]?.description).toBe("");
    expect(state.ticketById["t-queued"]?.queuedAt).toBeUndefined();
    expect(state.lanes[0]?.queuedTicketIds).toEqual([]);
    expect(state.lanes[1]?.admittedTicketIds).toEqual(["t-queued"]);
  });
});
