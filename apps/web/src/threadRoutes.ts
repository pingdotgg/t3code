import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { DraftId } from "./composerDraftStore";

export type ThreadRouteTarget =
  | {
      kind: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      kind: "draft";
      draftId: DraftId;
    };

export interface AgentRunRouteSearch {
  agent?: string | undefined;
}

export function parseAgentRunRouteSearch(search: Record<string, unknown>): AgentRunRouteSearch {
  if (typeof search.agent !== "string") return {};
  const agent = search.agent.trim();
  return agent ? { agent } : {};
}

export function clearAgentRunRouteSearch<T extends Record<string, unknown>>(
  search: T,
): Omit<T, "agent"> & AgentRunRouteSearch {
  const { agent: _agent, ...rest } = search;
  return { ...rest, agent: undefined };
}

export function buildThreadRouteParams(ref: ScopedThreadRef): {
  environmentId: EnvironmentId;
  threadId: ThreadId;
} {
  return {
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  };
}

export function buildDraftThreadRouteParams(draftId: DraftId): {
  draftId: DraftId;
} {
  return { draftId };
}

export function buildThreadRouteTargetLocation(target: ThreadRouteTarget):
  | {
      to: "/$environmentId/$threadId";
      params: ReturnType<typeof buildThreadRouteParams>;
    }
  | {
      to: "/draft/$draftId";
      params: ReturnType<typeof buildDraftThreadRouteParams>;
    } {
  return target.kind === "server"
    ? {
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(target.threadRef),
      }
    : {
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(target.draftId),
      };
}

export function threadRouteTargetsEqual(
  left: ThreadRouteTarget | null | undefined,
  right: ThreadRouteTarget | null | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind) {
    return left === right;
  }

  if (left.kind === "server" && right.kind === "server") {
    return (
      left.threadRef.environmentId === right.threadRef.environmentId &&
      left.threadRef.threadId === right.threadRef.threadId
    );
  }

  if (left.kind === "draft" && right.kind === "draft") {
    return left.draftId === right.draftId;
  }

  return false;
}

export function resolveThreadRouteRef(
  params: Partial<Record<"environmentId" | "threadId", string | undefined>>,
): ScopedThreadRef | null {
  if (!params.environmentId || !params.threadId) {
    return null;
  }

  return scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId);
}

export function resolveThreadRouteTarget(
  params: Partial<Record<"environmentId" | "threadId" | "draftId", string | undefined>>,
): ThreadRouteTarget | null {
  if (params.environmentId && params.threadId) {
    return {
      kind: "server",
      threadRef: scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId),
    };
  }

  if (!params.draftId) {
    return null;
  }

  return {
    kind: "draft",
    draftId: params.draftId as DraftId,
  };
}
