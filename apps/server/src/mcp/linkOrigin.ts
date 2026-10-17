import {
  OrchestratorMcpFailure,
  type OrchestrationV2LinkOrigin,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { Caller } from "./threadAccess.ts";

/**
 * Work a linked environment starts here stays within that link. An agent
 * reaches this environment through a link as one MCP client session, and
 * everything that session starts, and everything that work starts in turn,
 * carries the session in `linkOrigin`. Such a caller may change only work from
 * the same link: not the user's own threads, not projects or settings, and
 * not work from another link. Reads are not fenced.
 *
 * This is a routing rule for T3's own tools. An agent the link starts still
 * runs as this environment's user.
 */

/** The link a caller acts for: its own session, or the link that started its thread. */
export const callerLinkOrigin = (
  caller: Pick<Caller, "scope" | "caller">,
): OrchestrationV2LinkOrigin | undefined =>
  caller.caller?.linkOrigin ??
  (caller.scope.client?.linked === true
    ? { sessionId: caller.scope.client.sessionId, label: caller.scope.client.label }
    : undefined);

const outsideLink = (origin: OrchestrationV2LinkOrigin, message: string) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `This work was started from ${origin.label} through a linked environment, so ${message}`,
  });

/** A thread a linked caller may change: one its own link started. */
export const assertSameLink = (
  caller: Pick<Caller, "scope" | "caller">,
  target: Pick<OrchestrationV2ThreadShell, "id" | "linkOrigin">,
) => {
  const origin = callerLinkOrigin(caller);
  return origin === undefined || target.linkOrigin?.sessionId === origin.sessionId
    ? Effect.void
    : Effect.fail(outsideLink(origin, `it may change only threads that link started.`));
};

/** Linked work never changes the environment itself: projects, settings, scheduled runs. */
export const assertNotLinked = (caller: Pick<Caller, "scope" | "caller">, what: string) => {
  const origin = callerLinkOrigin(caller);
  return origin === undefined
    ? Effect.void
    : Effect.fail(outsideLink(origin, `it cannot ${what}.`));
};
