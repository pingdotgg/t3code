import {
  isListedThreadLineage,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";

import type { EnvironmentThreadShell } from "./state/models.ts";
import { threadSearchSubject, type ThreadSearchShell } from "./state/threadSearch.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export type ComposerThreadCandidate = ThreadSearchShell &
  Pick<EnvironmentThreadShell, "archivedAt" | "lineage">;

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

/** A mention cannot hold a space, so dashes, underscores, and dots stand in for one. */
export function composerThreadQuery(query: string): string {
  return query.replace(/[-_.]+/g, " ");
}

/**
 * Threads to reference from the composer, matched and ranked like the command
 * palette, without subagent threads or other threads' side chats. The agent reads threads
 * on its own server and on the machines it links to, so candidates stay within those, and a
 * linked machine's threads say which machine they are on.
 */
export function matchComposerThreadItems(
  input: {
    shells: ReadonlyArray<ComposerThreadCandidate>;
    environmentId: EnvironmentId;
    /** The machines the composer's environment links to, by name. */
    linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
    excludeThreadId: ThreadId | null;
    query: string;
    /** Recency is measured against this time. */
    now: number;
  },
  resolve: MFunctionType = mFallback,
): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  const normalizedQuery = foldSearchQuery(composerThreadQuery(input.query));
  if (query.length === 0) return [];
  // Closing an unused side chat deletes it, so only one with a message is offered.
  const isOwnSideChat = (shell: ComposerThreadCandidate) =>
    shell.lineage.sideChat === true &&
    shell.environmentId === input.environmentId &&
    shell.lineage.parentThreadId === input.excludeThreadId &&
    shell.latestUserMessageAt !== null;
  const candidates = input.shells.filter(
    (shell) =>
      (shell.environmentId === input.environmentId ||
        input.linkedEnvironments.has(shell.environmentId)) &&
      !(shell.environmentId === input.environmentId && shell.id === input.excludeThreadId) &&
      shell.archivedAt === null &&
      (isListedThreadLineage(shell.lineage) || isOwnSideChat(shell)),
  );
  return rankSearchItems(candidates, (shell, options) => {
    const subject = threadSearchSubject(shell, null);
    const searchOptions = { ...options, picks: false };
    const literal = scoreThreadSearch(query, subject, input.now, searchOptions);
    if (query === normalizedQuery || normalizedQuery.length === 0) return literal;
    const normalized = scoreThreadSearch(normalizedQuery, subject, input.now, searchOptions);
    return literal !== null && (normalized === null || literal.score >= normalized.score)
      ? literal
      : normalized;
  })
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
        description: isOwnSideChat(shell)
          ? resolve(msg("Side chat"))
          : machine === undefined
            ? resolve(msg("Thread", { $context: "noun, search result type" }))
            : resolve(msg("Thread on {machine}", { machine })),
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
 * The machines the `@` picker offers, so the agent can link or work there: the client's paired
 * machines and those the composer's environment links to. The composer's own environment is
 * left out. Like threads, they need a query: bare `@` stays a file picker.
 */
export function matchComposerEnvironmentItems(
  input: {
    environments: ReadonlyArray<ComposerEnvironmentCandidate>;
    /** The machines the composer's environment links to, by name. */
    linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
    environmentId: EnvironmentId;
    query: string;
  },
  resolve: MFunctionType = mFallback,
): ComposerEnvironmentItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  const paired = new Set(input.environments.map((environment) => environment.environmentId));
  const linkedOnly = Array.from(input.linkedEnvironments, ([environmentId, label]) => ({
    environmentId,
    label,
    machine: "server" as const,
  })).filter((environment) => !paired.has(environment.environmentId));
  return [...input.environments, ...linkedOnly]
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
      description: resolve(msg("Machine", { $context: "noun, search result type" })),
    }));
}
