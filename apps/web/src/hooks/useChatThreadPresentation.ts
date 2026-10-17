import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";
import { isStreamingProjectionTextUpdate, isStreamingTurnItemTextUpdate } from "../session-logic";
import { environmentThreadDetails } from "../state/threads";

/** Token text belongs to the assistant row; lifecycle and metadata still update the chat view. */
export function useChatThreadPresentation(ref: ScopedThreadRef | null, searching: boolean) {
  const presentation = useMemo(() => {
    let previous: EnvironmentThread | null = null;
    let previousVisible: OrchestrationV2ThreadProjection["visibleTurnItems"] = [];
    let value: {
      projection: OrchestrationV2ThreadProjection | null;
      visibleTurnItems: OrchestrationV2ThreadProjection["visibleTurnItems"];
    } = { projection: null, visibleTurnItems: [] };
    return Atom.make((get) => {
      const next = ref === null ? null : get(environmentThreadDetails.threadAtom(ref));
      const visible = ref === null ? [] : get(environmentThreadDetails.visibleTurnItemsAtom(ref));
      const textOnly =
        !searching &&
        previous !== null &&
        next !== null &&
        isStreamingProjectionTextUpdate(previous.projection, next.projection) &&
        visible.length === previousVisible.length &&
        visible.every(
          (row, index) =>
            row === previousVisible[index] ||
            isStreamingTurnItemTextUpdate(previousVisible[index]!, row),
        );
      previous = next;
      previousVisible = visible;
      if (!textOnly) value = { projection: next?.projection ?? null, visibleTurnItems: visible };
      return value;
    });
  }, [ref, searching]);
  return useAtomValue(presentation);
}
