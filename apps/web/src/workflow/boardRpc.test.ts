import {
  BoardId,
  type AgentSelection,
  type BoardListEntry,
  type BoardSnapshot,
  type EnvironmentApi,
  type ProjectId,
  StepRunId,
  TicketId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  answerTicketStep,
  createBoard,
  deleteBoard,
  editTicket,
  listBoards,
  renameBoard,
} from "./boardRpc";

describe("boardRpc", () => {
  it("delegates listBoards and createBoard through the workflow EnvironmentApi", async () => {
    const projectId = "project-web" as ProjectId;
    const boardId = BoardId.make("project-web__delivery");
    const agent = { instance: "codex_main", model: "gpt-5.5" } satisfies AgentSelection;
    const entries = [
      {
        boardId,
        name: "Delivery",
        filePath: ".t3/boards/delivery.json",
        error: null,
      },
    ] satisfies BoardListEntry[];
    const snapshot = {
      projectId,
      board: { boardId, name: "Delivery", lanes: [] },
      tickets: [],
    } satisfies BoardSnapshot;
    const api = {
      workflow: {
        listBoards: vi.fn(async () => entries),
        createBoard: vi.fn(async () => ({
          boardId,
          snapshot,
        })),
        deleteBoard: vi.fn(async () => undefined),
        renameBoard: vi.fn(async () => undefined),
        answerTicketStep: vi.fn(async () => undefined),
        editTicket: vi.fn(async () => undefined),
      },
    } as unknown as EnvironmentApi;

    await expect(listBoards(api, projectId)).resolves.toBe(entries);
    await expect(createBoard(api, { projectId, name: "Delivery", agent })).resolves.toEqual({
      boardId,
      snapshot,
    });
    await expect(deleteBoard(api, boardId)).resolves.toBeUndefined();
    await expect(renameBoard(api, boardId, "Renamed Delivery")).resolves.toBeUndefined();
    await expect(
      answerTicketStep(api, {
        stepRunId: StepRunId.make("step-1"),
        text: "Use sandbox.",
        attachments: [],
      }),
    ).resolves.toBeUndefined();
    await expect(
      editTicket(api, {
        ticketId: TicketId.make("ticket-1"),
        title: "Updated",
        description: "",
      }),
    ).resolves.toBeUndefined();

    expect(api.workflow.listBoards).toHaveBeenCalledWith({ projectId });
    expect(api.workflow.createBoard).toHaveBeenCalledWith({ projectId, name: "Delivery", agent });
    expect(api.workflow.deleteBoard).toHaveBeenCalledWith({ boardId });
    expect(api.workflow.renameBoard).toHaveBeenCalledWith({ boardId, name: "Renamed Delivery" });
    expect(api.workflow.answerTicketStep).toHaveBeenCalledWith({
      stepRunId: StepRunId.make("step-1"),
      text: "Use sandbox.",
      attachments: [],
    });
    expect(api.workflow.editTicket).toHaveBeenCalledWith({
      ticketId: TicketId.make("ticket-1"),
      title: "Updated",
      description: "",
    });
  });
});
