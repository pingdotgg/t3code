import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { useCallback, useMemo, useState } from "react";

import { groupArtifacts } from "../domain/artifact";
import { boardRoots, type FilesBoard } from "../files/target";
import { boardArtifactsAtom, boardArtifactsKey, NO_ARTIFACTS } from "../state/artifacts";
import type { BoardModel } from "../state/boardModel";
import type { Artifact } from "../store/artifacts";
import type { ValidBoard } from "../store/boardFiles";
import { type ArtifactsValue, BOARD_KEY } from "./ArtifactsContext";

export interface BoardArtifacts {
  readonly value: ArtifactsValue;
  /** The card count of each ticket whose cards are open, which the layout makes room for. */
  readonly cards: Readonly<Record<string, number>>;
  readonly viewing: Artifact | null;
  readonly closeViewer: () => void;
}

/** A board's artifacts, which cards are open, and the one the viewer shows. */
export function useBoardArtifacts(
  project: EnvironmentProject,
  listed: ValidBoard,
  model: BoardModel,
): BoardArtifacts {
  const { board } = listed;
  const tickets = useMemo(
    () => Object.values(model.lanes).flatMap((lane) => lane.map((view) => view.ticket)),
    [model],
  );
  const worktreeKey = tickets.flatMap((ticket) => ticket.worktreePath ?? []).join("\n");
  const all =
    useAtomValue(
      boardArtifactsAtom(
        boardArtifactsKey(
          project.id,
          listed.folder,
          worktreeKey === "" ? [] : worktreeKey.split("\n"),
        ),
      ),
    ) ?? NO_ARTIFACTS;
  const groups = useMemo(
    () =>
      groupArtifacts(
        all,
        tickets.map((ticket) => ticket.key),
      ),
    [all, tickets],
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [viewing, setViewing] = useState<Artifact | null>(null);
  const toggle = useCallback(
    (key: string) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const cards = useMemo(
    () =>
      Object.fromEntries(
        [...expanded]
          .filter((key) => key !== BOARD_KEY)
          .map((key) => [key, groups.byTicket.get(key)?.length ?? 0]),
      ),
    [expanded, groups],
  );
  const closeViewer = useCallback(() => setViewing(null), []);
  const files = useMemo<FilesBoard>(
    () => ({
      environmentId: project.environmentId,
      // The engine serves an absolute path whichever thread names it, and a board has a thread of its own to name.
      mediaThreadId: board.orchestratorThreadId ?? board.id,
      orchestratorThreadId: board.orchestratorThreadId,
      roots: boardRoots(project, tickets),
    }),
    [project, board.id, board.orchestratorThreadId, tickets],
  );
  return {
    value: {
      files,
      all,
      groups,
      expanded,
      toggle,
      open: setViewing,
    },
    cards,
    viewing,
    closeViewer,
  };
}
