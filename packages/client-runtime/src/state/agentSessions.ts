import { WS_METHODS, type ResumableAgentSession } from "@t3tools/contracts";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { fileBasename } from "../markdownLinks.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Resume picker RPCs, instantiated by each client with its own connection
 * runtime. Refresh after attachment because reopening within the idle TTL
 * reuses the cached list without revalidating it.
 */
export function createAgentSessionResumeAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:agent-sessions:list",
    tag: WS_METHODS.agentSessionsList,
    staleTimeMs: 0,
    idleTtlMs: 30_000,
  });
  return {
    list,
    attach: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-sessions:attach",
      tag: WS_METHODS.agentSessionsAttach,
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.refresh(list({ environmentId, input: { projectId: input.projectId } }));
        }),
    }),
  };
}

const RESUME_COMMAND_PREFIX = /^(?:codex\s+resume|claude\s+--resume)\s+/i;

/** Matches title, ID, branch, directory, or provider. A pasted resume command matches its ID. */
export function filterResumableSessions(
  sessions: ReadonlyArray<ResumableAgentSession>,
  search: string,
): ReadonlyArray<ResumableAgentSession> {
  const query = normalizeSearchQuery(search, { trimLeadingPattern: RESUME_COMMAND_PREFIX });
  if (!query) return sessions;
  return sessions.filter((session) =>
    [session.title, session.sessionId, session.branch, session.cwd, session.provider].some(
      (value) => value?.toLowerCase().includes(query),
    ),
  );
}

/** The branch a session ran on, or its directory name outside Git. */
export function resumableSessionLocation(session: ResumableAgentSession): string {
  return session.branch ?? fileBasename(session.cwd);
}
