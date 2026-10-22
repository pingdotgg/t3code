import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "../state/threads";

const SEPARATOR = "\u0000";

// Keyed by the environment and thread ids joined with SEPARATOR.
const asideTitlesAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const [environmentId, ...threadIds] = key.split(SEPARATOR);
    if (!environmentId || threadIds.length === 0) return "";
    return threadIds
      .map(
        (threadId) =>
          get(
            environmentThreadShells.threadShellAtom(
              scopeThreadRef(environmentId as EnvironmentId, threadId as ThreadId),
            ),
          )?.title.replaceAll(SEPARATOR, " ") ?? "Side chat",
      )
      .join(SEPARATOR);
  }),
);

/**
 * Tab titles of the open side chats. The derived atom is a joined string, so
 * it compares by value and the chat view re-renders only when a title changes,
 * not on every status update of a running side chat.
 */
export function useAsideTitles(
  environmentId: EnvironmentId | null,
  threadIds: ReadonlyArray<string>,
): ReadonlyMap<string, string> {
  const key = threadIds.join(SEPARATOR);
  const joined = useAtomValue(
    asideTitlesAtom(
      environmentId === null || key === "" ? "" : `${environmentId}${SEPARATOR}${key}`,
    ),
  );
  const titles = joined === "" ? [] : joined.split(SEPARATOR);
  return new Map(
    key === "" ? [] : key.split(SEPARATOR).map((id, i) => [id, titles[i] ?? "Side chat"]),
  );
}
