import type { BoardStreamItem } from "@t3tools/contracts";

export interface BoardState {
  readonly projectId: string | null;
  readonly boardId: string | null;
  readonly boardName: string;
  readonly lanes: ReadonlyArray<{
    readonly key: string;
    readonly name: string;
    readonly entry: string;
    readonly pipelineStepCount: number;
    readonly wipLimit?: number | undefined;
    readonly terminal?: boolean | undefined;
    readonly actions?:
      | ReadonlyArray<{
          readonly label: string;
          readonly to: string;
          readonly hint?: string | undefined;
        }>
      | undefined;
    readonly admittedTicketIds: ReadonlyArray<string>;
    readonly queuedTicketIds: ReadonlyArray<string>;
  }>;
  readonly ticketIds: ReadonlyArray<string>;
  readonly ticketById: Record<
    string,
    {
      readonly ticketId: string;
      readonly title: string;
      readonly description?: string | undefined;
      readonly currentLaneKey: string;
      readonly status: string;
      readonly queuedAt?: string | undefined;
      readonly totalTokens?: number | undefined;
      readonly unresolvedDependencyCount?: number | undefined;
      readonly tokenBudget?: number | undefined;
      readonly updatedAt?: string | undefined;
      readonly totalDurationMs?: number | undefined;
      readonly pr?:
        | {
            readonly number: number;
            readonly url: string;
            readonly state: "open" | "merged" | "closed";
            readonly ciState?: "pending" | "success" | "failure" | undefined;
          }
        | undefined;
    }
  >;
}

export const emptyBoardState: BoardState = {
  projectId: null,
  boardId: null,
  boardName: "",
  lanes: [],
  ticketIds: [],
  ticketById: {},
};

const isQueuedTicket = (ticket: BoardState["ticketById"][string]): boolean =>
  ticket.status === "queued" || ticket.queuedAt !== undefined;

const buildLaneGroups = (
  lanes: BoardState["lanes"],
  ticketIds: ReadonlyArray<string>,
  ticketById: BoardState["ticketById"],
): BoardState["lanes"] =>
  lanes.map((lane) => {
    const admittedTicketIds: string[] = [];
    const queuedTicketIds: string[] = [];
    for (const ticketId of ticketIds) {
      const ticket = ticketById[ticketId];
      if (!ticket || ticket.currentLaneKey !== lane.key) {
        continue;
      }
      if (isQueuedTicket(ticket)) {
        queuedTicketIds.push(ticketId);
      } else {
        admittedTicketIds.push(ticketId);
      }
    }

    return {
      ...lane,
      admittedTicketIds,
      queuedTicketIds,
    };
  });

export const applyBoardStreamItem = (state: BoardState, item: BoardStreamItem): BoardState => {
  if (item.kind === "snapshot") {
    const ticketById: BoardState["ticketById"] = {};
    for (const ticket of item.snapshot.tickets) {
      ticketById[ticket.ticketId] = {
        ticketId: ticket.ticketId,
        title: ticket.title,
        ...(ticket.description === undefined ? {} : { description: ticket.description }),
        currentLaneKey: ticket.currentLaneKey,
        status: ticket.status,
        ...(ticket.queuedAt === undefined ? {} : { queuedAt: ticket.queuedAt }),
        ...(ticket.totalTokens === undefined ? {} : { totalTokens: ticket.totalTokens }),
        ...(ticket.unresolvedDependencyCount === undefined
          ? {}
          : { unresolvedDependencyCount: ticket.unresolvedDependencyCount }),
        ...(ticket.tokenBudget === undefined ? {} : { tokenBudget: ticket.tokenBudget }),
        ...(ticket.updatedAt === undefined ? {} : { updatedAt: ticket.updatedAt }),
        ...(ticket.totalDurationMs === undefined
          ? {}
          : { totalDurationMs: ticket.totalDurationMs }),
        ...(ticket.pr === undefined ? {} : { pr: ticket.pr }),
      };
    }
    const ticketIds = item.snapshot.tickets.map((ticket) => ticket.ticketId);
    const lanes = buildLaneGroups(
      item.snapshot.board.lanes.map((lane) => ({
        ...lane,
        admittedTicketIds: [],
        queuedTicketIds: [],
      })),
      ticketIds,
      ticketById,
    );

    return {
      projectId: item.snapshot.projectId,
      boardId: item.snapshot.board.boardId,
      boardName: item.snapshot.board.name,
      lanes,
      ticketIds,
      ticketById,
    };
  }

  const ticket = item.ticket;
  const exists = state.ticketById[ticket.ticketId] !== undefined;
  const ticketIds = exists ? state.ticketIds : [...state.ticketIds, ticket.ticketId];
  const ticketById = {
    ...state.ticketById,
    [ticket.ticketId]: {
      ticketId: ticket.ticketId,
      title: ticket.title,
      ...(ticket.description === undefined ? {} : { description: ticket.description }),
      currentLaneKey: ticket.currentLaneKey,
      status: ticket.status,
      ...(ticket.queuedAt === undefined ? {} : { queuedAt: ticket.queuedAt }),
      ...(ticket.totalTokens === undefined ? {} : { totalTokens: ticket.totalTokens }),
      ...(ticket.unresolvedDependencyCount === undefined
        ? {}
        : { unresolvedDependencyCount: ticket.unresolvedDependencyCount }),
      ...(ticket.tokenBudget === undefined ? {} : { tokenBudget: ticket.tokenBudget }),
      ...(ticket.updatedAt === undefined ? {} : { updatedAt: ticket.updatedAt }),
      ...(ticket.totalDurationMs === undefined ? {} : { totalDurationMs: ticket.totalDurationMs }),
      ...(ticket.pr === undefined ? {} : { pr: ticket.pr }),
    },
  };
  return {
    ...state,
    lanes: buildLaneGroups(state.lanes, ticketIds, ticketById),
    ticketIds,
    ticketById,
  };
};
