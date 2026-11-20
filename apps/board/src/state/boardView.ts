import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import * as Result from "effect/Result";
import { useMemo, useState } from "react";

import { parseTickets, type Ticket, type TicketsIssue } from "../domain/ticket";
import { type OrchestratorStats, orchestratorStats } from "../orchestrator/brief";
import type { ValidBoard } from "../store/boardFiles";
import { type BoardModel, joinBoard } from "./boardModel";
import { useDriverOf, useThreadFamily } from "./family";
import { boardStoreAtom } from "./orchestrator";

const NO_FILES = { tickets: null, forYou: null, decisions: null };
const NO_TICKETS: ReadonlyArray<Ticket> = [];

export interface BoardView {
  readonly model: BoardModel;
  /** Why `tickets.json` could not be read in full. The model keeps the last tickets that could. */
  readonly issue: TicketsIssue | null;
  /** The orchestrator card's numbers. Its ticket counts come from the same tickets the lanes show. */
  readonly stats: OrchestratorStats;
}

/** The board's tickets joined with its orchestrator's agents. */
export function useBoardView(project: EnvironmentProject, listed: ValidBoard): BoardView {
  const { board } = listed;
  const files = useAtomValue(boardStoreAtom(`${project.id}/${listed.folder}`)) ?? NO_FILES;
  const parsed = useMemo(
    () => (files.tickets === null ? Result.succeed(NO_TICKETS) : parseTickets(files.tickets)),
    [files.tickets],
  );
  const [lastValid, setLastValid] = useState<{
    text: string | null;
    tickets: ReadonlyArray<Ticket>;
  }>({
    text: null,
    tickets: NO_TICKETS,
  });
  if (Result.isSuccess(parsed) && parsed.success !== lastValid.tickets) {
    setLastValid({ text: files.tickets, tickets: parsed.success });
  }
  const tickets = Result.isSuccess(parsed) ? parsed.success : lastValid.tickets;

  const family = useThreadFamily(project.environmentId, board.orchestratorThreadId);
  const driverOf = useDriverOf();
  const model = useMemo(
    () =>
      joinBoard({
        tickets,
        family,
        orchestratorThreadId: board.orchestratorThreadId ?? "",
        driverOf,
      }),
    [tickets, family, board.orchestratorThreadId, driverOf],
  );
  return {
    model,
    issue: Result.isFailure(parsed) ? parsed.failure : null,
    stats: orchestratorStats(
      { ...files, tickets: Result.isSuccess(parsed) ? files.tickets : lastValid.text },
      board.builderCap,
    ),
  };
}
