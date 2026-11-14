import * as DateTime from "effect/DateTime";

import type { OrchestrationV2TurnItemStatus, ProviderInstanceId } from "@t3tools/contracts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import { museItemStatus } from "./itemPresentation.ts";
import { MUSE_PROVIDER } from "./museCapabilities.ts";
import type { ActiveTurn, ChildContext } from "./museSessionTypes.ts";
import type { MuseItem } from "./protocol.ts";

const nativeRef = (nativeId: string) => ({
  driver: MUSE_PROVIDER,
  nativeId,
  strength: "strong" as const,
});
/** The roster lists a child under its turn item's native id, so readers can pair the two. */
const backgroundTaskId = (item: MuseItem) =>
  item.kind === "subagent" ? item.childSessionId || item.subagentId || item.itemId : item.itemId;

/** Ids and base rows for Muse items; the session core owns sequencing state on the turn. */
export const makeMuseItemProjection = (deps: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly instanceId: ProviderInstanceId;
}) => {
  const { idAllocator, instanceId } = deps;
  const itemIdentity = (turn: ActiveTurn, nativeId: string) =>
    `${instanceId}:${turn.input.providerThread.id}:${turn.nativeId}:${nativeId}`;
  const baseItem = (turn: ActiveTurn, nativeId: string, time: DateTime.Utc) => {
    if (!turn.ordinals.has(nativeId)) turn.ordinals.set(nativeId, turn.nextOrdinal++);
    if (!turn.started.has(nativeId)) turn.started.set(nativeId, time);
    const identity = itemIdentity(turn, nativeId);
    return {
      id: idAllocator.derive.turnItemFromProviderItem({
        driver: MUSE_PROVIDER,
        nativeItemId: identity,
      }),
      nodeId: idAllocator.derive.nodeFromProviderItem({
        driver: MUSE_PROVIDER,
        nativeItemId: identity,
      }),
      threadId: turn.input.threadId,
      runId: turn.input.runId,
      providerThreadId: turn.input.providerThread.id,
      providerTurnId: turn.providerTurn.id,
      nativeItemRef: nativeRef(nativeId),
      parentItemId: null,
      ordinal: turn.ordinals.get(nativeId)!,
      startedAt: turn.started.get(nativeId)!,
      updatedAt: time,
    };
  };
  const childItemIdentity = (context: ChildContext, nativeId: string) =>
    `${instanceId}:child:${context.childSessionId}:${nativeId}`;
  const itemStatus = (item: MuseItem): OrchestrationV2TurnItemStatus => {
    const status = museItemStatus(item);
    return status === "running" &&
      item.kind === "subagent" &&
      item.controlStatus === "resultReady"
      ? "completed"
      : status;
  };

  return { itemIdentity, baseItem, childItemIdentity, itemStatus, nativeRef, backgroundTaskId };
};

export type MuseItemProjection = ReturnType<typeof makeMuseItemProjection>;
