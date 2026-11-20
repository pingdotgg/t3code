import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import {
  type BoardOpenItems,
  cardTitle,
  cardViews,
  engineRequestsOf,
  type CardView,
  NO_TOASTS,
  type ForYouProblem,
  mergeForYou,
  nextToasts,
  openCards,
  type SentCard,
  type ToastState,
} from "../domain/forYou";
import type { ValidBoard } from "../store/boardFiles";
import { useThreadFamily } from "./family";
import { projectBoardsAtom } from "./boards";
import { boardStoreAtom } from "./orchestrator";
import { engineEnvironmentIdAtom, environmentProjects, environmentSnapshotAtom } from "./projects";

type SentByBoard = Readonly<Record<string, ReadonlyMap<string, SentCard>>>;

/** The cards the user answered this session, by board id then card id. */
export const forYouSentAtom = Atom.make<SentByBoard>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("foryou-sent"),
);

const NO_SENT: ReadonlyMap<string, SentCard> = new Map();

export interface BoardForYou {
  readonly views: ReadonlyArray<CardView>;
  readonly problems: ReadonlyArray<ForYouProblem>;
  /** Cards waiting on the user, from the file and from the engine. */
  readonly open: number;
}

/** A board's cards: its `foryou.jsonl` and the requests its thread family waits on, joined with what the user answered. */
export function useBoardForYou(project: EnvironmentProject, listed: ValidBoard): BoardForYou {
  const files = useAtomValue(boardStoreAtom(`${project.id}/${listed.folder}`));
  const family = useThreadFamily(project.environmentId, listed.board.orchestratorThreadId);
  const sent = useAtomValue(forYouSentAtom)[listed.board.id] ?? NO_SENT;
  const text = files?.forYou ?? null;
  return useMemo(() => {
    const merged = mergeForYou(text, engineRequestsOf(family));
    return {
      views: cardViews(merged.cards, sent),
      problems: merged.problems,
      open: openCards(merged.cards).length,
    };
  }, [text, family, sent]);
}

const NO_BOARDS: ReadonlyArray<BoardOpenItems> = [];

/**
 * Every board's open items, across projects. Engine requests come from the shell stream, which
 * lists a thread that waits on the user, so no board needs to be open to count them.
 */
export const forYouBoardsAtom = Atom.make((get): ReadonlyArray<BoardOpenItems> => {
  const environmentId = get(engineEnvironmentIdAtom);
  if (environmentId === null) return NO_BOARDS;
  const waiting = (get(environmentSnapshotAtom(environmentId))?.threads ?? []).filter(
    (thread) =>
      thread.pendingRuntimeRequest !== null &&
      thread.archivedAt === null &&
      thread.deletedAt === null,
  );
  return get(environmentProjects.projectsAtom)
    .filter((project) => project.archivedAt == null)
    .flatMap((project) => {
      const boards = get(projectBoardsAtom(project.id));
      if (boards.status !== "ready") return [];
      return boards.boards.flatMap((listed): BoardOpenItems[] => {
        if (!listed.ok || listed.board.archived) return [];
        const files = get(boardStoreAtom(`${project.id}/${listed.folder}`));
        const root = listed.board.orchestratorThreadId;
        const requests = engineRequestsOf(
          root === null ? [] : waiting.filter((thread) => thread.lineage.rootThreadId === root),
        );
        return [
          {
            projectId: project.id,
            folder: listed.folder,
            boardId: listed.board.id,
            boardName: listed.board.name,
            loaded: files !== null,
            open: openCards(mergeForYou(files?.forYou ?? null, requests).cards).map((card) => ({
              id: card.id,
              title: cardTitle(card),
            })),
          },
        ];
      });
    });
}).pipe(Atom.withLabel("foryou-boards"));

/** The toasts on screen, which follow every board's open items and which a toast removes itself from. */
export const forYouToastsAtom = Atom.writable(
  (get): ToastState =>
    nextToasts(
      Option.getOrElse(get.self<ToastState>(), () => NO_TOASTS),
      get(forYouBoardsAtom),
    ),
  (context, next: ToastState) => context.setSelf(next),
).pipe(Atom.keepAlive, Atom.withLabel("foryou-toasts"));

/** The card a toast or the sidebar row sent the user to, which its lane marks and brings into view. */
export const focusedCardAtom = Atom.make<{
  readonly boardId: string;
  readonly cardId: string;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("foryou-focused-card"));
