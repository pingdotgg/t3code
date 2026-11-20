import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { useCallback, useContext, useSyncExternalStore } from "react";

import type { BoardForYou } from "../state/forYou";
import { focusedCardAtom } from "../state/forYou";
import { boardStoreAtom } from "../state/orchestrator";
import type { ValidBoard } from "../store/boardFiles";
import { ForYouCard } from "./ForYouCard";

const FOCUS_MS = 4_000;
/** While a card waits on the orchestrator's record, the file is read this often, not every few seconds. */
const SENT_POLL_MS = 1_000;
const RESOLVED_SHOWN = 3;
const NO_UNSUBSCRIBE = () => undefined;

/** The For-you lane's cards, open ones first, then the latest resolved ones in a line each. */
export function ForYouLane({
  project,
  listed,
  forYou,
  focusedId,
}: {
  project: EnvironmentProject;
  listed: ValidBoard;
  forYou: BoardForYou;
  focusedId: string | null;
}) {
  const registry = useContext(RegistryContext);
  const { views, open } = forYou;
  const { board } = listed;
  const waitingOnFile = views.some((view) => view.state === "sent" && view.card.origin === "file");
  const storeKey = `${project.id}/${listed.folder}`;

  // External timers that follow the render, which `useSyncExternalStore` starts and stops with it.
  useSyncExternalStore(
    useCallback(() => {
      if (!waitingOnFile) return NO_UNSUBSCRIBE;
      const timer = setInterval(() => registry.refresh(boardStoreAtom(storeKey)), SENT_POLL_MS);
      return () => clearInterval(timer);
    }, [registry, storeKey, waitingOnFile]),
    () => null,
  );
  useSyncExternalStore(
    useCallback(() => {
      if (focusedId === null) return NO_UNSUBSCRIBE;
      const timer = setTimeout(() => registry.set(focusedCardAtom, null), FOCUS_MS);
      return () => clearTimeout(timer);
    }, [registry, focusedId]),
    () => null,
  );

  const resolved = views.filter((view) => view.state === "resolved");
  // One list, so a card that resolves keeps its element and its marks.
  const shown = [
    ...views.filter((view) => view.state !== "resolved"),
    ...resolved.slice(-RESOLVED_SHOWN),
  ];
  const context = (id: string) => ({
    target: { registry, environmentId: project.environmentId, boardId: board.id },
    orchestratorThreadId: board.orchestratorThreadId ?? "",
    focused: id === focusedId,
  });
  return (
    <div data-testid="foryou-lane" className="flex flex-col gap-2 px-3 pb-3">
      <p className="text-[11px] text-faint">{open === 0 ? "Nothing needs you" : `${open} open`}</p>
      {shown.map((view) => (
        <ForYouCard key={view.card.id} view={view} context={context(view.card.id)} />
      ))}
      {resolved.length > RESOLVED_SHOWN && (
        <p className="text-[11px] text-faint">{resolved.length - RESOLVED_SHOWN} older resolved</p>
      )}
    </div>
  );
}
