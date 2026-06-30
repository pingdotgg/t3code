import {
  MessageId,
  StepRunId,
  type EnvironmentApi,
  type TicketAttachment,
  TicketId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  filterBoardStateByQuery,
  getBoardRouteEmptyState,
  submitTicketAnswerFromBoardRoute,
  submitTicketEditFromBoardRoute,
  submitTicketMessageEditFromBoardRoute,
} from "./_chat.$environmentId.board";

describe("getBoardRouteEmptyState", () => {
  it("distinguishes no selection from a missing requested board", () => {
    expect(getBoardRouteEmptyState({ boardId: null, boardLoadError: null })).toEqual({
      title: "No board selected.",
      description: null,
    });

    expect(
      getBoardRouteEmptyState({
        boardId: "project-1__missing" as never,
        boardLoadError: "Workflow board project-1__missing was not found",
      }),
    ).toEqual({
      title: "Board not found.",
      description: "Workflow board project-1__missing was not found",
    });
  });
});

describe("board route ticket actions", () => {
  it("returns the answer RPC promise and reloads only after it resolves", async () => {
    let resolveAnswer: (() => void) | undefined;
    const rpcPromise = new Promise<void>((resolve) => {
      resolveAnswer = resolve;
    });
    const api = {
      workflow: {
        answerTicketStep: vi.fn(() => rpcPromise),
      },
    } as unknown as EnvironmentApi;
    const reloadTicketDetail = vi.fn();
    const attachments = [] satisfies ReadonlyArray<TicketAttachment>;

    const result = submitTicketAnswerFromBoardRoute(
      api,
      {
        stepRunId: "step-awaiting",
        text: "Use the compatibility guard.",
        attachments,
      },
      reloadTicketDetail,
    );

    expect(api.workflow.answerTicketStep).toHaveBeenCalledWith({
      stepRunId: StepRunId.make("step-awaiting"),
      text: "Use the compatibility guard.",
      attachments,
    });
    expect(reloadTicketDetail).not.toHaveBeenCalled();

    resolveAnswer?.();
    await expect(result).resolves.toBeUndefined();
    expect(reloadTicketDetail).toHaveBeenCalledOnce();
  });

  it("propagates answer RPC failures without reloading", async () => {
    const api = {
      workflow: {
        answerTicketStep: vi.fn(async () => {
          throw new Error("answer failed");
        }),
      },
    } as unknown as EnvironmentApi;
    const reloadTicketDetail = vi.fn();

    await expect(
      submitTicketAnswerFromBoardRoute(
        api,
        { stepRunId: "step-awaiting", text: "Try again." },
        reloadTicketDetail,
      ),
    ).rejects.toThrow("answer failed");
    expect(reloadTicketDetail).not.toHaveBeenCalled();
  });

  it("rejects ticket actions when the environment API is unavailable", async () => {
    await expect(
      submitTicketAnswerFromBoardRoute(
        null,
        { stepRunId: "step-awaiting", text: "Try again." },
        vi.fn(),
      ),
    ).rejects.toThrow("Environment API unavailable.");

    await expect(
      submitTicketEditFromBoardRoute(
        undefined,
        { ticketId: "ticket-1", title: "Updated" },
        vi.fn(),
      ),
    ).rejects.toThrow("Environment API unavailable.");
  });

  it("returns the edit RPC promise and reloads only after it resolves", async () => {
    const api = {
      workflow: {
        editTicket: vi.fn(async () => undefined),
      },
    } as unknown as EnvironmentApi;
    const reloadTicketDetail = vi.fn();

    await expect(
      submitTicketEditFromBoardRoute(
        api,
        {
          ticketId: "ticket-1",
          title: "Retitle",
          description: "",
        },
        reloadTicketDetail,
      ),
    ).resolves.toBeUndefined();

    expect(api.workflow.editTicket).toHaveBeenCalledWith({
      ticketId: TicketId.make("ticket-1"),
      title: "Retitle",
      description: "",
    });
    expect(reloadTicketDetail).toHaveBeenCalledOnce();
  });

  it("edits a ticket message and reloads only after the RPC resolves", async () => {
    let resolveEdit: (() => void) | undefined;
    const rpcPromise = new Promise<void>((resolve) => {
      resolveEdit = resolve;
    });
    const api = {
      workflow: {
        editTicketMessage: vi.fn(() => rpcPromise),
      },
    } as unknown as EnvironmentApi;
    const reloadTicketDetail = vi.fn();

    const result = submitTicketMessageEditFromBoardRoute(
      api,
      { ticketId: "ticket-1", messageId: "message-1", body: "Updated body." },
      reloadTicketDetail,
    );

    expect(api.workflow.editTicketMessage).toHaveBeenCalledWith({
      ticketId: TicketId.make("ticket-1"),
      messageId: MessageId.make("message-1"),
      body: "Updated body.",
    });
    expect(reloadTicketDetail).not.toHaveBeenCalled();

    resolveEdit?.();
    await expect(result).resolves.toBeUndefined();
    expect(reloadTicketDetail).toHaveBeenCalledOnce();
  });

  it("rejects ticket message edits when the environment API is unavailable", async () => {
    await expect(
      submitTicketMessageEditFromBoardRoute(
        null,
        { ticketId: "ticket-1", messageId: "message-1", body: "Updated body." },
        vi.fn(),
      ),
    ).rejects.toThrow("Environment API unavailable.");
  });
});

describe("filterBoardStateByQuery", () => {
  const state = {
    projectId: "p1",
    boardId: "b1",
    boardName: "Board",
    lanes: [
      {
        key: "work",
        name: "Work",
        entry: "auto",
        pipelineStepCount: 1,
        admittedTicketIds: ["t1", "t2"],
        queuedTicketIds: ["t3"],
      },
    ],
    ticketIds: ["t1", "t2", "t3"],
    ticketById: {
      t1: {
        ticketId: "t1",
        title: "Fix login flow",
        currentLaneKey: "work",
        status: "running",
      },
      t2: {
        ticketId: "t2",
        title: "Polish dashboard",
        description: "Charts misalign on login",
        currentLaneKey: "work",
        status: "idle",
      },
      t3: {
        ticketId: "t3",
        title: "Unrelated chore",
        currentLaneKey: "work",
        status: "queued",
        queuedAt: "2026-06-09T00:00:00.000Z",
      },
    },
  };

  it("returns the same state for an empty query", () => {
    expect(filterBoardStateByQuery(state, "   ")).toBe(state);
  });

  it("matches titles and descriptions case-insensitively", () => {
    const filtered = filterBoardStateByQuery(state, "LOGIN");
    expect(filtered.ticketIds).toEqual(["t1", "t2"]);
    expect(filtered.lanes[0]?.admittedTicketIds).toEqual(["t1", "t2"]);
    expect(filtered.lanes[0]?.queuedTicketIds).toEqual([]);
  });

  it("filters queued tickets too", () => {
    const filtered = filterBoardStateByQuery(state, "chore");
    expect(filtered.ticketIds).toEqual(["t3"]);
    expect(filtered.lanes[0]?.admittedTicketIds).toEqual([]);
    expect(filtered.lanes[0]?.queuedTicketIds).toEqual(["t3"]);
  });
});
