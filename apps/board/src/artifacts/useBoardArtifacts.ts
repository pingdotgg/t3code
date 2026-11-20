import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { useCallback, useContext, useMemo, useState } from "react";

import { groupArtifacts } from "../domain/artifact";
import { boardRoots, type FilesBoard, locate } from "../files/target";
import { boardArtifactsAtom, boardArtifactsKey, NO_ARTIFACTS } from "../state/artifacts";
import type { BoardModel } from "../state/boardModel";
import { openFile } from "../state/filesView";
import type { Artifact } from "../store/artifacts";
import type { ValidBoard } from "../store/boardFiles";
import { type ArtifactsValue, BOARD_KEY } from "./ArtifactsContext";

export interface BoardArtifacts {
  readonly value: ArtifactsValue;
  /** The card count of each ticket whose cards are open, which the layout makes room for. */
  readonly cards: Readonly<Record<string, number>>;
}

/** A board's artifacts, and which cards are open. Opening one opens its file as a tab in the main view. */
export function useBoardArtifacts(
  project: EnvironmentProject,
  listed: ValidBoard,
  model: BoardModel,
): BoardArtifacts {
  const registry = useContext(RegistryContext);
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
  const files = useMemo<FilesBoard>(
    () => ({
      environmentId: project.environmentId,
      // The engine serves an absolute path whichever thread names it, and a board has a thread of its own to name.
      mediaThreadId: board.orchestratorThreadId ?? board.id,
      roots: boardRoots(project, tickets),
    }),
    [project, board.id, board.orchestratorThreadId, tickets],
  );
  const open = useCallback(
    (artifact: Artifact) => {
      const located = locate(files.roots, artifact.absolutePath);
      if (located !== null) openFile(registry, { cwd: located.root.cwd, path: located.path });
    },
    [registry, files.roots],
  );
  return {
    value: {
      files,
      all,
      groups,
      expanded,
      toggle,
      open,
    },
    cards,
  };
}
