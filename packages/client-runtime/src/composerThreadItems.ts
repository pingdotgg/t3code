import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type McpGatewayProfile,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import type { ComposerAgentProfile } from "@t3tools/shared/composerContextReferences";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";

import { isOpenListedThread, type EnvironmentThreadShell } from "./state/models.ts";
import { threadSearchSubject, type ThreadSearchShell } from "./state/threadSearch.ts";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export type ComposerThreadCandidate = ThreadSearchShell &
  Pick<EnvironmentThreadShell, "archivedAt" | "lineage" | "parentThreadId" | "parentRelationship">;

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

/**
 * Threads to reference from the composer, matched and ranked like the command
 * palette, without subagent or side chat threads. The agent reads threads on its own server
 * and on the machines it links to, so candidates stay within those, and a linked
 * machine's threads say which machine they are on.
 */
export function matchComposerThreadItems(input: {
  shells: ReadonlyArray<ComposerThreadCandidate>;
  environmentId: EnvironmentId;
  /** The machines the composer's environment links to, by name. */
  linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  excludeThreadId: ThreadId | null;
  query: string;
  /** Recency is measured against this time. */
  now: number;
}): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  if (query.length === 0) return [];
  const candidates = input.shells.filter(
    (shell) =>
      (shell.environmentId === input.environmentId ||
        input.linkedEnvironments.has(shell.environmentId)) &&
      shell.id !== input.excludeThreadId &&
      isOpenListedThread(shell),
  );
  return rankSearchItems(candidates, (shell, options) =>
    scoreThreadSearch(query, threadSearchSubject(shell, null), input.now, {
      ...options,
      picks: false,
    }),
  )
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map(({ item: shell }) => {
      const machine =
        shell.environmentId === input.environmentId
          ? undefined
          : input.linkedEnvironments.get(shell.environmentId);
      return {
        id: `thread:${shell.environmentId}:${shell.id}`,
        type: "thread",
        thread: { environmentId: shell.environmentId, threadId: shell.id },
        label: shell.title,
        description: machine === undefined ? "Thread" : `Thread on ${machine}`,
      };
    });
}

export interface ComposerEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

export interface ComposerEnvironmentItem {
  readonly id: string;
  readonly type: "environment";
  readonly environmentId: EnvironmentId;
  readonly machine: EnvironmentMachineKind;
  readonly label: string;
  readonly description: string;
}

/**
 * The user's machines the `@` picker offers, so the agent can link or work there. The
 * composer's own environment is left out. Like threads, they need a query: bare `@` stays a
 * file picker.
 */
export function matchComposerEnvironmentItems(input: {
  environments: ReadonlyArray<ComposerEnvironmentCandidate>;
  environmentId: EnvironmentId;
  query: string;
}): ComposerEnvironmentItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  return input.environments
    .filter(
      (environment) =>
        environment.environmentId !== input.environmentId &&
        environment.label.toLowerCase().includes(query),
    )
    .map((environment) => ({
      id: `environment:${environment.environmentId}`,
      type: "environment",
      environmentId: environment.environmentId,
      machine: environment.machine,
      label: environment.label,
      description: "Machine",
    }));
}

export type ComposerAgentCandidate = ComposerAgentProfile &
  Pick<McpGatewayProfile, "description" | "modelLabel">;

export interface ComposerAgentItem {
  readonly id: string;
  readonly type: "agent";
  readonly agent: ComposerAgentProfile;
  readonly label: string;
  readonly description: string;
}

/**
 * The user's T3 agents the `@` picker offers, matched by name ignoring case. Names that differ
 * only in case carry a detail so the user picks the exact agent. Like threads, they need a query.
 */
export function matchComposerAgentItems(input: {
  agents: ReadonlyArray<ComposerAgentCandidate>;
  environmentId: EnvironmentId;
  query: string;
  machineLabel?: (environmentId: string) => string | undefined;
}): ComposerAgentItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  const sameName = new Map<string, number>();
  for (const agent of input.agents) {
    const key = agent.name.toLowerCase();
    sameName.set(key, (sameName.get(key) ?? 0) + 1);
  }
  const rank = (name: string) => (name === query ? 0 : name.startsWith(query) ? 1 : 2);
  return input.agents
    .filter((agent) => agent.name.toLowerCase().includes(query))
    .sort((left, right) => rank(left.name.toLowerCase()) - rank(right.name.toLowerCase()))
    .map((agent) => {
      const parts = ["Agent"];
      const allowed = agent.environmentIds ?? [];
      if (allowed.length > 0 && !allowed.includes(input.environmentId)) {
        const machines = allowed.map((id) => input.machineLabel?.(id) ?? id);
        parts.push(`runs on ${machines.join(", ")}`);
      }
      if (agent.runtimeMode === "read-only") parts.push("read-only");
      if ((sameName.get(agent.name.toLowerCase()) ?? 0) > 1) {
        parts.push(agent.description?.trim() || agent.modelLabel || agent.profileId);
      }
      return {
        id: `agent:${agent.profileId}`,
        type: "agent",
        agent: {
          profileId: agent.profileId,
          name: agent.name,
          runtimeMode: agent.runtimeMode,
          ...(agent.environmentIds ? { environmentIds: agent.environmentIds } : {}),
        },
        label: agent.name,
        description: parts.join(" · "),
      };
    });
}
