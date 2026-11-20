import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import * as Result from "effect/Result";
import { useMemo } from "react";

import { parseTickets } from "../domain/ticket";
import { boardStoreAtom } from "../state/orchestrator";
import type { ValidBoard } from "../store/boardFiles";
import { boardRoots, type FilesBoard } from "./target";

/** The roots of a board and the threads its files are served and reported under. */
export function useFilesBoard(project: EnvironmentProject, listed: ValidBoard): FilesBoard {
  const tickets = useAtomValue(boardStoreAtom(`${project.id}/${listed.folder}`))?.tickets ?? null;
  const { board } = listed;
  return useMemo(() => {
    const parsed = tickets === null ? null : parseTickets(tickets);
    return {
      environmentId: project.environmentId,
      // The engine serves an absolute path whichever thread names it, and a board has a thread of its own to name.
      mediaThreadId: board.orchestratorThreadId ?? board.id,
      orchestratorThreadId: board.orchestratorThreadId,
      roots: boardRoots(project, parsed !== null && Result.isSuccess(parsed) ? parsed.success : []),
    };
  }, [project, board.id, board.orchestratorThreadId, tickets]);
}
