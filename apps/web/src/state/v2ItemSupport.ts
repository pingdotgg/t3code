import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Atom } from "effect/unstable/reactivity";

import { environmentThreadDetails } from "./threads";

type Projection = OrchestrationV2ThreadProjection;

export interface V2ItemSupport {
  readonly item: Projection["turnItems"][number] | null;
  readonly run: Projection["runs"][number] | null;
  readonly attempts: ReadonlyArray<Projection["attempts"][number]>;
  readonly node: Projection["nodes"][number] | null;
  readonly providerSession: Projection["providerSessions"][number] | null;
  readonly providerThread: Projection["providerThreads"][number] | null;
  readonly providerTurn: Projection["providerTurns"][number] | null;
  readonly runtimeRequest: Projection["runtimeRequests"][number] | null;
  readonly checkpoint: Projection["checkpoints"][number] | null;
  readonly subagent: Projection["subagents"][number] | null;
  readonly contextHandoff: Projection["contextHandoffs"][number] | null;
  readonly contextTransfer: Projection["contextTransfers"][number] | null;
}

const EMPTY_SUPPORT: V2ItemSupport = Object.freeze({
  item: null,
  run: null,
  attempts: Object.freeze([]),
  node: null,
  providerSession: null,
  providerThread: null,
  providerTurn: null,
  runtimeRequest: null,
  checkpoint: null,
  subagent: null,
  contextHandoff: null,
  contextTransfer: null,
});

function supportKey(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
}): string {
  return JSON.stringify(input);
}

function parseSupportKey(key: string): {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
} {
  return JSON.parse(key) as {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  };
}

function sameEntities<A>(left: ReadonlyArray<A>, right: ReadonlyArray<A>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSupport(left: V2ItemSupport, right: V2ItemSupport): boolean {
  return (
    left.item === right.item &&
    left.run === right.run &&
    sameEntities(left.attempts, right.attempts) &&
    left.node === right.node &&
    left.providerSession === right.providerSession &&
    left.providerThread === right.providerThread &&
    left.providerTurn === right.providerTurn &&
    left.runtimeRequest === right.runtimeRequest &&
    left.checkpoint === right.checkpoint &&
    left.subagent === right.subagent &&
    left.contextHandoff === right.contextHandoff &&
    left.contextTransfer === right.contextTransfer
  );
}

const itemSupportAtomFamily = Atom.family((key: string) => {
  const target = parseSupportKey(key);
  const ref = scopeThreadRef(target.environmentId, target.threadId);
  let previous = EMPTY_SUPPORT;
  return Atom.make((get): V2ItemSupport => {
    const scoped = get(environmentThreadDetails.threadAtom(ref));
    if (scoped === null) return EMPTY_SUPPORT;
    const projection = scoped.projection;
    const item =
      projection.turnItems.find((candidate) => candidate.id === target.itemId) ??
      projection.visibleTurnItems.find((candidate) => candidate.sourceItemId === target.itemId)
        ?.item ??
      null;
    if (item === null) return EMPTY_SUPPORT;
    const run =
      item.runId === null
        ? null
        : (projection.runs.find((candidate) => candidate.id === item.runId) ?? null);
    const attempts =
      item.runId === null
        ? EMPTY_SUPPORT.attempts
        : projection.attempts.filter((candidate) => candidate.runId === item.runId);
    const node =
      item.nodeId === null
        ? null
        : (projection.nodes.find((candidate) => candidate.id === item.nodeId) ?? null);
    const providerThread =
      item.providerThreadId === null
        ? null
        : (projection.providerThreads.find((candidate) => candidate.id === item.providerThreadId) ??
          null);
    const providerSession =
      providerThread?.providerSessionId == null
        ? null
        : (projection.providerSessions.find(
            (candidate) => candidate.id === providerThread.providerSessionId,
          ) ?? null);
    const providerTurn =
      item.providerTurnId === null
        ? null
        : (projection.providerTurns.find((candidate) => candidate.id === item.providerTurnId) ??
          null);
    const requestId =
      item.type === "approval_request" || item.type === "user_input_request"
        ? item.requestId
        : node?.runtimeRequestId;
    const runtimeRequest =
      requestId == null
        ? null
        : (projection.runtimeRequests.find((candidate) => candidate.id === requestId) ?? null);
    const checkpoint =
      item.type === "checkpoint"
        ? (projection.checkpoints.find((candidate) => candidate.id === item.checkpointId) ?? null)
        : null;
    const subagent =
      item.type === "subagent"
        ? (projection.subagents.find((candidate) => candidate.id === item.subagentId) ?? null)
        : null;
    const contextHandoff =
      item.type === "handoff"
        ? (projection.contextHandoffs.find((candidate) => candidate.id === item.contextHandoffId) ??
          null)
        : null;
    const contextTransfer =
      contextHandoff?.transferId == null
        ? null
        : (projection.contextTransfers.find(
            (candidate) => candidate.id === contextHandoff.transferId,
          ) ?? null);
    const next: V2ItemSupport = {
      item,
      run,
      attempts,
      node,
      providerSession,
      providerThread,
      providerTurn,
      runtimeRequest,
      checkpoint,
      subagent,
      contextHandoff,
      contextTransfer,
    };
    if (sameSupport(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-v2-item-support:${key}`));
});

export function useV2ItemSupport(input: {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
}): V2ItemSupport {
  return useAtomValue(
    itemSupportAtomFamily(
      supportKey({
        environmentId: input.environmentId,
        threadId: input.sourceThreadId,
        itemId: input.sourceItemId,
      }),
    ),
  );
}
