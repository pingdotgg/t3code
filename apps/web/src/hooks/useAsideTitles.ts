import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { environmentThreadShells } from "../state/threads";

const SEPARATOR = "\u0000";

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
  const titlesAtom = useMemo(
    () =>
      Atom.make((get) =>
        environmentId === null
          ? ""
          : key === ""
            ? ""
            : key
                .split(SEPARATOR)
                .map(
                  (threadId) =>
                    get(
                      environmentThreadShells.threadShellAtom(
                        scopeThreadRef(environmentId, threadId as ThreadId),
                      ),
                    )?.title.replaceAll(SEPARATOR, " ") ?? "Side chat",
                )
                .join(SEPARATOR),
      ),
    [environmentId, key],
  );
  const joined = useAtomValue(titlesAtom);
  return useMemo(() => {
    const titles = joined === "" ? [] : joined.split(SEPARATOR);
    return new Map(
      key === "" ? [] : key.split(SEPARATOR).map((id, i) => [id, titles[i] ?? "Side chat"]),
    );
  }, [joined, key]);
}
