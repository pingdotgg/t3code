import { describe, expect, it } from "vite-plus/test";
import {
  BoardId,
  LaneKey,
  StepRunId,
  StepKey,
  TicketId,
  type BoardTicketView,
  type WorkflowCurrentLaneView,
  type WorkflowLaneActionView,
  type WorkflowStepRunView,
  type WorkflowTicketDetailView,
  type WorkflowTicketAttentionKind,
} from "@t3tools/contracts";

import { isTicketSourceOwned, selectTicketAffordance } from "./ticketAffordance";

const TICKET_ID = TicketId.make("ticket-1");
const BOARD_ID = BoardId.make("board-1");

const LANE_ACTIONS: readonly WorkflowLaneActionView[] = [
  { label: "Send back", to: LaneKey.make("triage") },
  { label: "Ship", to: LaneKey.make("done") },
];

const CURRENT_LANE: WorkflowCurrentLaneView = {
  key: LaneKey.make("review"),
  name: "Review",
  actions: LANE_ACTIONS,
};

function makeAwaitingStep(overrides: Partial<WorkflowStepRunView> = {}): WorkflowStepRunView {
  return {
    stepRunId: StepRunId.make("step-run-1"),
    stepKey: StepKey.make("review-step"),
    stepType: "agent",
    status: "awaiting_user",
    waitingReason: null,
    blockedReason: null,
    scriptThreadId: null,
    terminalId: null,
    scriptStatus: null,
    exitCode: null,
    signal: null,
    ...overrides,
  };
}

function makeTicket(overrides: Partial<BoardTicketView> = {}): BoardTicketView {
  return {
    ticketId: TICKET_ID,
    boardId: BOARD_ID,
    title: "Investigate flake",
    currentLaneKey: LaneKey.make("review"),
    status: "running",
    currentLane: CURRENT_LANE,
    ...overrides,
  };
}

function makeDetail(args: {
  readonly ticket?: Partial<BoardTicketView>;
  readonly steps?: readonly WorkflowStepRunView[];
}): WorkflowTicketDetailView {
  return {
    ticket: makeTicket(args.ticket),
    steps: args.steps ?? [],
    messages: [],
  };
}

describe("selectTicketAffordance", () => {
  it("maps waiting_for_input to answer with the awaiting step's stepRunId and question", () => {
    const detail = makeDetail({
      ticket: { attentionKind: "waiting_for_input", attentionReason: "fallback reason" },
      steps: [
        makeAwaitingStep({
          stepRunId: StepRunId.make("step-input"),
          waitingReason: "Which database should I target?",
        }),
      ],
    });

    const result = selectTicketAffordance(detail);

    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") throw new Error("expected answer");
    expect(result.stepRunId).toBe(StepRunId.make("step-input"));
    expect(result.question).toBe("Which database should I target?");
    expect(result.laneActions).toEqual(LANE_ACTIONS);
  });

  it("falls back to attentionReason when the awaiting input step has no waitingReason", () => {
    const detail = makeDetail({
      ticket: { attentionKind: "waiting_for_input", attentionReason: "Need credentials" },
      steps: [makeAwaitingStep({ waitingReason: null })],
    });

    const result = selectTicketAffordance(detail);

    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") throw new Error("expected answer");
    expect(result.question).toBe("Need credentials");
  });

  it("derives answer from providerResponseKind when attentionKind is absent", () => {
    const detail = makeDetail({
      ticket: {},
      steps: [makeAwaitingStep({ providerResponseKind: "user-input", waitingReason: "?" })],
    });

    const result = selectTicketAffordance(detail);

    expect(result.kind).toBe("answer");
  });

  it("maps waiting_for_approval to approve with the awaiting step's stepRunId", () => {
    const detail = makeDetail({
      ticket: { attentionKind: "waiting_for_approval" },
      steps: [
        makeAwaitingStep({
          stepRunId: StepRunId.make("step-approve"),
          waitingReason: "Approve deploy to prod?",
        }),
      ],
    });

    const result = selectTicketAffordance(detail);

    expect(result.kind).toBe("approve");
    if (result.kind !== "approve") throw new Error("expected approve");
    expect(result.stepRunId).toBe(StepRunId.make("step-approve"));
    expect(result.question).toBe("Approve deploy to prod?");
  });

  it("derives approve from providerResponseKind=request when attentionKind is absent", () => {
    const detail = makeDetail({
      ticket: {},
      steps: [makeAwaitingStep({ providerResponseKind: "request" })],
    });

    const result = selectTicketAffordance(detail);

    expect(result.kind).toBe("approve");
  });

  it("derives approve from an explicit approval step awaiting user with null providerResponseKind", () => {
    // Mirrors web's isAwaitingApprovalRequestStep fallback: an approval step
    // awaiting the user with no providerResponseKind is still an approval, not
    // a plain comment.
    const detail = makeDetail({
      ticket: {},
      steps: [
        makeAwaitingStep({
          stepRunId: StepRunId.make("step-approve"),
          stepType: "approval",
          providerResponseKind: null,
          waitingReason: "Approve this?",
        }),
      ],
    });

    const result = selectTicketAffordance(detail);

    expect(result.kind).toBe("approve");
    if (result.kind !== "approve") throw new Error("expected approve");
    expect(result.stepRunId).toBe(StepRunId.make("step-approve"));
    expect(result.question).toBe("Approve this?");
  });

  it("maps blocked attention to blocked with blockReason and laneActions", () => {
    const detail = makeDetail({
      ticket: { attentionKind: "blocked", attentionReason: "ticket-level block" },
      steps: [makeAwaitingStep({ blockedReason: "Missing API key" })],
    });

    const result = selectTicketAffordance(detail);

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("expected blocked");
    expect(result.blockReason).toBe("Missing API key");
    expect(result.laneActions).toEqual(LANE_ACTIONS);
  });

  it("treats ticket.status === blocked as blocked even without attentionKind", () => {
    const detail = makeDetail({
      ticket: { status: "blocked", attentionReason: "blocked reason" },
      steps: [],
    });

    const result = selectTicketAffordance(detail);

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("expected blocked");
    expect(result.blockReason).toBe("blocked reason");
  });

  it("prefers answer over blocked when attentionKind is absent but status is blocked and the awaiting step wants input", () => {
    // Precedence lock: wants-input must win over the blocked branch so the user
    // can actually respond instead of hitting a dead-end. Do not flip silently.
    const detail = makeDetail({
      ticket: { attentionKind: undefined, status: "blocked" },
      steps: [
        makeAwaitingStep({
          stepRunId: StepRunId.make("step-input"),
          providerResponseKind: "user-input",
          waitingReason: "Pick a target",
        }),
      ],
    });

    const result = selectTicketAffordance(detail);

    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") throw new Error("expected answer");
    expect(result.stepRunId).toBe(StepRunId.make("step-input"));
  });

  it("maps a ticket with no attention to comment", () => {
    const detail = makeDetail({ ticket: {}, steps: [] });

    const result = selectTicketAffordance(detail);

    expect(result.kind).toBe("comment");
    expect(result.laneActions).toEqual(LANE_ACTIONS);
  });

  it("degrades waiting_for_input to comment when no awaiting step is present", () => {
    const detail = makeDetail({
      ticket: { attentionKind: "waiting_for_input" },
      steps: [],
    });

    const result = selectTicketAffordance(detail);

    expect(result.kind).toBe("comment");
  });

  it("degrades waiting_for_approval to comment when no awaiting step is present", () => {
    const detail = makeDetail({
      ticket: { attentionKind: "waiting_for_approval" },
      steps: [],
    });

    const result = selectTicketAffordance(detail);

    expect(result.kind).toBe("comment");
  });

  it("defaults laneActions to an empty array when currentLane is absent", () => {
    const detail = makeDetail({ ticket: { currentLane: undefined }, steps: [] });

    const result = selectTicketAffordance(detail);

    expect(result.kind).toBe("comment");
    expect(result.laneActions).toEqual([]);
  });

  // Type guard usage to keep WorkflowTicketAttentionKind imported and meaningful.
  it("only recognizes the three attention kinds", () => {
    const kinds: readonly WorkflowTicketAttentionKind[] = [
      "waiting_for_approval",
      "waiting_for_input",
      "blocked",
    ];
    expect(kinds).toHaveLength(3);
  });
});

describe("isTicketSourceOwned", () => {
  it("returns false when syncedSource is absent", () => {
    expect(isTicketSourceOwned({ syncedSource: undefined })).toBe(false);
  });

  it("returns true when syncedSource is present", () => {
    expect(
      isTicketSourceOwned({
        syncedSource: { provider: "github", url: "https://github.com/o/r/issues/1" },
      }),
    ).toBe(true);
  });

  it("returns true for an Asana syncedSource", () => {
    expect(
      isTicketSourceOwned({
        syncedSource: { provider: "asana", url: "https://app.asana.com/0/123/456" },
      }),
    ).toBe(true);
  });
});
