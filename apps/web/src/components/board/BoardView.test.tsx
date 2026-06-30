import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoardView, resolveBoardDropLaneKey, type BoardViewState } from "./BoardView";

const boardState = {
  lanes: [
    {
      key: "backlog",
      name: "Backlog",
      entry: "manual",
      pipelineStepCount: 0,
      wipLimit: 1,
      admittedTicketIds: ["ticket-1"],
      queuedTicketIds: ["ticket-3"],
    },
    {
      key: "done",
      name: "Done",
      entry: "manual",
      pipelineStepCount: 0,
      terminal: true,
      admittedTicketIds: ["ticket-2"],
      queuedTicketIds: [],
    },
  ],
  ticketIds: ["ticket-1", "ticket-2", "ticket-3"],
  ticketById: {
    "ticket-1": {
      ticketId: "ticket-1",
      title: "Add board lanes",
      currentLaneKey: "backlog",
      status: "waiting_on_user",
    },
    "ticket-2": {
      ticketId: "ticket-2",
      title: "Ship milestone",
      currentLaneKey: "done",
      status: "done",
    },
    "ticket-3": {
      ticketId: "ticket-3",
      title: "Wait for review capacity",
      currentLaneKey: "backlog",
      queuedAt: "2026-06-07T00:00:00.000Z",
      status: "queued",
    },
  },
} satisfies BoardViewState;

describe("BoardView", () => {
  it("renders lanes, ticket cards, and status badges", () => {
    const markup = renderToStaticMarkup(
      <BoardView state={boardState} onMove={() => {}} onOpen={() => {}} />,
    );

    expect(markup).toContain("Backlog");
    expect(markup).toContain("Done");
    expect(markup).toContain("Add board lanes");
    expect(markup).toContain("Ship milestone");
    expect(markup).toContain("waiting on you");
    expect(markup).toContain("done");
    expect(markup).toContain("1/1");
    expect(markup).toContain("Queued");
    expect(markup).toContain("Wait for review capacity");
    expect(markup).toContain("queued");
  });

  it("resolves a card drop target back to the destination lane", () => {
    expect(resolveBoardDropLaneKey(boardState, "ticket-1", "lane:done")).toBe("done");
    expect(resolveBoardDropLaneKey(boardState, "ticket-1", "ticket-2")).toBe("done");
    expect(resolveBoardDropLaneKey(boardState, "ticket-1", "ticket-1")).toBeNull();
  });
});
