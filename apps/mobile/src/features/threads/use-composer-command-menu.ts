import * as Dialog from "../../components/ui/Dialog";
import type {
  EnvironmentId,
  ProjectId,
  ServerProvider,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  type ComposerEnvironmentCandidate,
  matchComposerEnvironmentItems,
  matchComposerThreadItems,
} from "@t3tools/client-runtime/composerThreadItems";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

const EMPTY_THREAD_SHELLS: ReadonlyArray<EnvironmentThreadShell> = [];
const EMPTY_ENVIRONMENTS: ReadonlyArray<ComposerEnvironmentCandidate> = [];
const NO_LINKED_ENVIRONMENTS: ReadonlyMap<EnvironmentId, string> = new Map();
import { COMPOSER_CONTEXT_MAX_RECORDS } from "@t3tools/contracts";
import {
  formatComposerContextReference,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { environmentComposerContext, pullRequestComposerContext } from "../../lib/composerContext";
import { uuidv4 } from "../../lib/uuid";
import {
  getComposerDraftSnapshot,
  setComposerDraftContext,
  useComposerDraftSelection,
} from "../../state/use-composer-drafts";
import { USAGE_LIMITS_COMMAND } from "@t3tools/shared/usageLimits";
import {
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
  type ComposerTrigger,
} from "@t3tools/shared/composerTrigger";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import {
  createProviderWorkspaceSnapshotRefreshAtomFamily,
  dedupeProviderSkillsByName,
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
  isProviderSkillUserInvocable,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import {
  formatComposerModelMention,
  rankComposerModelMentions,
} from "@t3tools/client-runtime/composer-model-mentions";
import { useAtomRefresh } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { serverEnvironment } from "../../state/server";
import {
  useComposerPathSearch,
  useComposerPullRequestSearch,
  useThreadSearch,
} from "../../state/queries";
import type { ModelOption } from "../../lib/modelOptions";
import type { ComposerCommandItem } from "./ComposerCommandPopover";
import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";

const providerWorkspaceSnapshotRefresh = createProviderWorkspaceSnapshotRefreshAtomFamily({
  providers: serverEnvironment.providersValueAtom,
  refreshProviders: serverEnvironment.refreshProviders,
});

const idleWorkspaceSnapshotRefreshAtom: Atom.Atom<unknown> = Atom.make<void>(undefined).pipe(
  Atom.withLabel("mobile:provider-workspace-snapshot-refresh:idle"),
);

function composerSelectionAtEnd(draftMessage: string): ComposerEditorSelection {
  return { start: draftMessage.length, end: draftMessage.length };
}

/**
 * A caret placed by an insertion (chips, pasted context) wins while the draft
 * still has the text it was placed in. Otherwise the composer's own caret is
 * clamped to the draft, and a caret from another owner starts at the end.
 */
export function resolveComposerMenuSelection(input: {
  readonly draftMessage: string;
  readonly ownerKey: string | null;
  readonly inserted: ComposerEditorSelection | null;
  readonly local: {
    readonly ownerKey: string | null;
    readonly start: number;
    readonly end: number;
  };
}): ComposerEditorSelection {
  if (input.inserted) return input.inserted;
  if (input.local.ownerKey !== input.ownerKey) return composerSelectionAtEnd(input.draftMessage);
  const length = input.draftMessage.length;
  return { start: Math.min(input.local.start, length), end: Math.min(input.local.end, length) };
}

export function buildComposerSlashCommandItems(input: {
  readonly query: string;
  readonly atMessageStart: boolean;
  readonly hasThread: boolean;
  readonly hasCompactableConversation?: boolean;
  readonly offersUsageLimits?: boolean;
  /** T3's `/clear` replaces the provider's, which would clear a session T3 still treats as live. */
  readonly offersFreshSession?: boolean;
  readonly offersSideChat?: boolean;
  readonly selectedProviderStatus: Pick<ServerProvider, "driver" | "slashCommands"> | null;
}): ComposerCommandItem[] {
  const query = input.query.toLowerCase();
  const items: ComposerCommandItem[] = "model".includes(query)
    ? [
        {
          id: "cmd:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch model",
        },
      ]
    : [];

  // Providers expand commands only at the start of a message. T3 commands
  // change local state and do not have this restriction, except `/clear`.
  if (!input.atMessageStart) return items;
  if (input.offersSideChat) {
    for (const [command, description] of [
      ["side", "Ask a side question in a new side chat"],
      ["btw", "Same as /side"],
    ] as const) {
      if (!command.includes(query)) continue;
      items.push({
        id: `cmd:${command}`,
        type: "slash-command",
        command,
        label: `/${command}`,
        description,
      });
    }
  }
  if (input.offersFreshSession && "clear".includes(query)) {
    items.push({
      id: "cmd:clear",
      type: "slash-command",
      command: "clear",
      label: "/clear",
      description: "Start a fresh session",
    });
  }
  for (const command of input.selectedProviderStatus?.slashCommands ?? []) {
    if (!command.name.toLowerCase().includes(query)) continue;
    if (command.name === "clear" && input.offersFreshSession) continue;
    if (command.name === "compact" && !input.hasCompactableConversation) continue;
    if (command.name === USAGE_LIMITS_COMMAND.name && input.offersUsageLimits && !input.hasThread) {
      continue;
    }
    if (
      !input.hasThread &&
      input.selectedProviderStatus?.driver === "codex" &&
      command.name === "feedback"
    ) {
      continue;
    }
    items.push({
      id: `pcmd:${command.name}`,
      type: "provider-slash-command",
      command,
      label: `/${command.name}`,
      description: command.description ?? "",
    });
  }
  return items;
}

export function buildComposerModelItems(
  modelOptions: ReadonlyArray<ModelOption>,
  query: string,
  providers: ReadonlyArray<ServerProvider>,
): ComposerCommandItem[] {
  // The picker retains saved selections even when their provider is no longer usable.
  const readyProviderIds = new Set(
    providers
      .filter(
        (provider) =>
          provider.installed &&
          provider.status === "ready" &&
          provider.auth.status !== "unauthenticated" &&
          provider.availability !== "unavailable",
      )
      .map((provider) => provider.instanceId),
  );
  return rankComposerModelMentions(
    modelOptions.filter(
      (option) =>
        readyProviderIds.has(option.selection.instanceId) &&
        !option.isUnavailable &&
        !option.isHidden &&
        !option.isLegacy,
    ),
    query,
    (option) => ({
      name: option.label,
      ...(option.subtitle ? { subProvider: option.subtitle } : {}),
      driverKind: option.providerDriver,
      providerDisplayName: option.providerLabel,
    }),
  ).map((option) => ({
    id: `model:${option.key}`,
    type: "model",
    option,
    label: option.label,
    description: option.subtitle
      ? `${option.providerLabel} · ${option.subtitle}`
      : option.providerLabel,
  }));
}

export function resolveComposerCommandSelection(input: {
  readonly draftMessage: string;
  readonly trigger: Pick<ComposerTrigger, "rangeStart" | "rangeEnd">;
  readonly item: ComposerCommandItem;
}): { readonly text: string; readonly cursor: number } {
  const { draftMessage, trigger, item } = input;
  let replacement = "";
  if (item.type === "path") {
    replacement = `${serializeComposerFileLink(item.path)} `;
  } else if (item.type === "skill") {
    replacement = `$${item.skill.name} `;
  } else if (item.type === "slash-command") {
    replacement = `/${item.command} `;
  } else if (item.type === "provider-slash-command") {
    replacement = `/${item.command.name} `;
  } else if (item.type === "model") {
    replacement = `${formatComposerModelMention(item.option.selection.instanceId, item.option.selection.model)} `;
  }
  return replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, replacement);
}

export function useComposerCommandMenu({
  draftMessage,
  ownerKey,
  environmentId,
  threadShells = EMPTY_THREAD_SHELLS,
  environments = EMPTY_ENVIRONMENTS,
  linkedEnvironments = NO_LINKED_ENVIRONMENTS,
  currentThreadId = null,
  projectCwd,
  pullRequestProjectId = null,
  pullRequestRepository = null,
  threadPullRequests,
  selectedProviderStatus,
  hasThread,
  hasCompactableConversation,
  offersUsageLimits = false,
  enabled = true,
  onChangeDraftMessage,
  onUsageLimits,
  modelOptions,
  modelProviders,
  onFreshSession,
  offersSideChat = false,
}: {
  readonly draftMessage: string;
  readonly ownerKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly threadShells?: ReadonlyArray<EnvironmentThreadShell>;
  readonly environments?: ReadonlyArray<ComposerEnvironmentCandidate>;
  /** The machines `environmentId` links to, by name, whose threads the picker also offers. */
  readonly linkedEnvironments?: ReadonlyMap<EnvironmentId, string>;
  readonly currentThreadId?: ThreadId | null;
  readonly projectCwd: string | null;
  readonly pullRequestProjectId?: ProjectId | null;
  readonly pullRequestRepository?: string | null;
  readonly threadPullRequests?: ReadonlyArray<ThreadPullRequestLink>;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly hasThread: boolean;
  readonly hasCompactableConversation: boolean;
  readonly offersUsageLimits?: boolean;
  readonly enabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onUsageLimits?: () => void;
  readonly modelOptions?: ReadonlyArray<ModelOption>;
  readonly modelProviders?: ReadonlyArray<ServerProvider>;
  /** Arms a fresh session for the next message; absent where `/clear` is unavailable. */
  readonly onFreshSession?: () => void;
  readonly offersSideChat?: boolean;
}) {
  const [localSelection, setLocalSelection] = useState(() => ({
    ownerKey,
    ...composerSelectionAtEnd(draftMessage),
  }));
  // Thread mentions rank by recency as of when the composer mounted.
  const [now] = useState(() => Date.now());
  const insertedSelection = useComposerDraftSelection(ownerKey, draftMessage);
  const selection = resolveComposerMenuSelection({
    draftMessage,
    ownerKey,
    inserted: insertedSelection,
    local: localSelection,
  });
  const setSelection = (next: ComposerEditorSelection) =>
    setLocalSelection({ ownerKey, start: next.start, end: next.end });

  const skills = selectedProviderStatus
    ? resolveProviderSkillsForCwd(selectedProviderStatus, projectCwd)
    : [];
  const selectedProviderInstanceId = selectedProviderStatus?.instanceId;
  const refreshWorkspaceSnapshot = useAtomRefresh(
    environmentId && projectCwd && selectedProviderInstanceId
      ? providerWorkspaceSnapshotRefresh({
          environmentId,
          instanceId: selectedProviderInstanceId,
          cwd: projectCwd,
        })
      : idleWorkspaceSnapshotRefreshAtom,
  );
  // Every draft change rechecks a stale snapshot, including drafts written by
  // another surface (a prompt link) that never move the editor selection.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the provider workspace snapshot atom whenever the draft text changes from any surface
  useEffect(() => {
    refreshWorkspaceSnapshot();
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Draft changes are the recheck signal.
    draftMessage,
    refreshWorkspaceSnapshot,
  ]);
  const onSelectionChange = (nextSelection: ComposerEditorSelection) => {
    setSelection(nextSelection);
  };

  const trigger = (() => {
    if (!enabled || selection.start !== selection.end) {
      return null;
    }
    return detectComposerTrigger(draftMessage, selection.end);
  })();
  const pathSearch = useComposerPathSearch({
    environmentId,
    cwd: trigger?.kind === "path" ? projectCwd : null,
    query: trigger?.kind === "path" ? trigger.query : null,
  });
  // Mounts older settled threads matching the mention, which shells may leave out.
  const threadSearch = useThreadSearch(
    trigger?.kind === "path" && environmentId ? [environmentId] : [],
    trigger?.kind === "path" ? trigger.query : "",
    { titlesOnly: true },
  );
  const pullRequestSearch = useComposerPullRequestSearch({
    environmentId,
    projectId: pullRequestProjectId,
    repository: pullRequestRepository,
    threadPullRequests,
    query: trigger?.kind === "pull-request" ? trigger.query : null,
  });

  const items = ((): ComposerCommandItem[] => {
    if (!trigger) return [];

    if (trigger.kind === "pull-request") {
      return pullRequestSearch.entries.map((entry) => ({
        id: `pr:${entry.projectId}:${entry.repository}:${entry.number}`,
        type: "pull-request",
        pullRequest: {
          number: entry.number,
          title: entry.title,
          url: entry.url,
          headBranch: entry.headBranch,
          baseBranch: entry.baseBranch,
          state: entry.state,
          isDraft: entry.isDraft,
        },
        label: `#${entry.number}`,
        description: `${entry.isDraft ? "Draft" : entry.state} · ${
          entry.repository.toLowerCase() === pullRequestRepository?.toLowerCase()
            ? ""
            : `${entry.repository} · `
        }${entry.title}`,
      }));
    }

    if (trigger.kind === "slash-command") {
      const q = trigger.query.toLowerCase();
      const visibleSkills = getProviderSkillsForSlashMenu(skills, true);
      const commandItems = buildComposerSlashCommandItems({
        query: q,
        atMessageStart: trigger.rangeStart === 0,
        hasThread,
        hasCompactableConversation,
        offersUsageLimits,
        offersFreshSession: onFreshSession !== undefined,
        offersSideChat,
        selectedProviderStatus: selectedProviderStatus
          ? {
              ...selectedProviderStatus,
              slashCommands: getProviderSlashCommandsForSlashMenu(
                resolveProviderSlashCommandsForCwd(selectedProviderStatus, projectCwd),
                visibleSkills,
              ),
            }
          : null,
      });

      const skillItems = visibleSkills
        .filter((skill) => matchesSlashSkillQuery(skill, q))
        .map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: `skill:${skill.name}`,
          description: skill.shortDescription ?? skill.description ?? "",
        }));

      return [...commandItems, ...skillItems];
    }

    if (trigger.kind === "skill") {
      const enabledSkills = dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable));
      const normalizedQuery = normalizeSearchQuery(trigger.query, {
        trimLeadingPattern: /^\p{Sc}+/u,
      });

      if (!normalizedQuery) {
        return enabledSkills.slice(0, 20).map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: skill.displayName ?? skill.name,
          description: skill.shortDescription ?? skill.description ?? "",
        }));
      }

      const ranked: Array<{
        item: (typeof enabledSkills)[number];
        score: number;
        tieBreaker: string;
      }> = [];
      for (const skill of enabledSkills) {
        const displayLabel = (skill.displayName ?? skill.name).toLowerCase();
        const scores = [
          scoreQueryMatch({
            value: skill.name.toLowerCase(),
            query: normalizedQuery,
            exactBase: 0,
            prefixBase: 2,
            boundaryBase: 4,
            includesBase: 6,
            fuzzyBase: 100,
            boundaryMarkers: ["-", "_", "/"],
          }),
          scoreQueryMatch({
            value: displayLabel,
            query: normalizedQuery,
            exactBase: 1,
            prefixBase: 3,
            boundaryBase: 5,
            includesBase: 7,
            fuzzyBase: 110,
          }),
          scoreQueryMatch({
            value: skill.shortDescription?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 20,
            prefixBase: 22,
            boundaryBase: 24,
            includesBase: 26,
          }),
          scoreQueryMatch({
            value: skill.description?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 30,
            prefixBase: 32,
            boundaryBase: 34,
            includesBase: 36,
          }),
        ].filter((score): score is number => score !== null);

        if (scores.length > 0) {
          insertRankedSearchResult(
            ranked,
            {
              item: skill,
              score: Math.min(...scores),
              tieBreaker: `${displayLabel}\u0000${skill.name}`,
            },
            20,
          );
        }
      }

      return ranked.map(({ item: skill }) => ({
        id: `skill:${skill.name}`,
        type: "skill" as const,
        skill,
        label: skill.displayName ?? skill.name,
        description: skill.shortDescription ?? skill.description ?? "",
      }));
    }

    if (trigger.kind === "path") {
      const threadItems = environmentId
        ? matchComposerThreadItems({
            shells: threadShells,
            environmentId,
            linkedEnvironments,
            excludeThreadId: currentThreadId,
            query: trigger.query,
            now,
          })
        : [];
      const environmentItems = environmentId
        ? matchComposerEnvironmentItems({ environments, environmentId, query: trigger.query })
        : [];
      const modelItems =
        modelOptions && modelProviders
          ? buildComposerModelItems(modelOptions, trigger.query, modelProviders)
          : [];
      return [
        ...threadItems,
        ...environmentItems,
        ...modelItems,
        ...pathSearch.entries.map((entry) => {
          const parts = entry.path.split("/");
          return {
            id: `path:${entry.path}`,
            type: "path" as const,
            path: entry.path,
            kind: entry.kind,
            label: parts[parts.length - 1] ?? entry.path,
            description: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
          };
        }),
      ];
    }

    return [];
  })();

  const onSelect = (item: ComposerCommandItem) => {
    if (!trigger) return;
    if (item.type === "environment") {
      if (!ownerKey || trigger.kind !== "path") return;
      const record = environmentComposerContext(item.environmentId, item.label);
      const existing = getComposerDraftSnapshot(ownerKey).context?.records ?? [];
      const alreadyAttached = existing.some((entry) => entry.contextId === record.contextId);
      if (!alreadyAttached && existing.length >= COMPOSER_CONTEXT_MAX_RECORDS) {
        Dialog.alert("Too many context items", "Remove some context from the draft and try again.");
        return;
      }
      const result = replaceTextRange(
        draftMessage,
        trigger.rangeStart,
        trigger.rangeEnd,
        `${formatComposerContextReference(record)} `,
      );
      onChangeDraftMessage(result.text);
      if (!alreadyAttached) {
        const draft = getComposerDraftSnapshot(ownerKey);
        setComposerDraftContext(ownerKey, {
          version: 1,
          records: [...(draft.context?.records ?? []), record],
        });
      }
      setSelection({ start: result.cursor, end: result.cursor });
      return;
    }
    if (item.type === "thread") {
      if (!ownerKey || trigger.kind !== "path") return;
      const shell = threadShells.find(
        (candidate) =>
          candidate.environmentId === item.thread.environmentId &&
          candidate.id === item.thread.threadId,
      );
      if (!shell) return;
      const record = threadContextRecord(item.thread, shell.title);
      const existing = getComposerDraftSnapshot(ownerKey).context?.records ?? [];
      const alreadyAttached = existing.some((entry) => entry.contextId === record.contextId);
      if (!alreadyAttached && existing.length >= COMPOSER_CONTEXT_MAX_RECORDS) {
        Dialog.alert("Too many context items", "Remove some context from the draft and try again.");
        return;
      }
      const result = replaceTextRange(
        draftMessage,
        trigger.rangeStart,
        trigger.rangeEnd,
        `${formatComposerContextReference(record)} `,
      );
      onChangeDraftMessage(result.text);
      if (!alreadyAttached) {
        const draft = getComposerDraftSnapshot(ownerKey);
        setComposerDraftContext(ownerKey, {
          version: 1,
          records: [...(draft.context?.records ?? []), record],
        });
      }
      setSelection({ start: result.cursor, end: result.cursor });
      return;
    }
    if (item.type === "pull-request") {
      if (
        !ownerKey ||
        trigger.kind !== "pull-request" ||
        !items.some((candidate) => candidate.id === item.id)
      )
        return;
      const record = pullRequestComposerContext(item.pullRequest, uuidv4());
      if (
        (getComposerDraftSnapshot(ownerKey).context?.records.length ?? 0) >=
        COMPOSER_CONTEXT_MAX_RECORDS
      ) {
        Dialog.alert("Too many context items", "Remove some context from the draft and try again.");
        return;
      }
      const result = replaceTextRange(
        draftMessage,
        trigger.rangeStart,
        trigger.rangeEnd,
        `${formatComposerContextReference(record)} `,
      );
      onChangeDraftMessage(result.text);
      const draft = getComposerDraftSnapshot(ownerKey);
      setComposerDraftContext(ownerKey, {
        version: 1,
        records: [...(draft.context?.records ?? []), record],
      });
      setSelection({ start: result.cursor, end: result.cursor });
      return;
    }

    if (item.type === "slash-command" && item.command === "clear" && onFreshSession) {
      const cleared = replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, "");
      setSelection({ start: cleared.cursor, end: cleared.cursor });
      onChangeDraftMessage(cleared.text);
      onFreshSession();
      return;
    }
    if (
      item.type === "provider-slash-command" &&
      item.command.name === USAGE_LIMITS_COMMAND.name &&
      onUsageLimits
    ) {
      const cleared = replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, "");
      setSelection({ start: cleared.cursor, end: cleared.cursor });
      onChangeDraftMessage(cleared.text);
      onUsageLimits();
      return;
    }

    const result = resolveComposerCommandSelection({ draftMessage, trigger, item });
    setSelection({ start: result.cursor, end: result.cursor });
    onChangeDraftMessage(result.text);
  };

  return {
    selection,
    onSelectionChange,
    trigger,
    items,
    searchesThreads: Boolean(environmentId && trigger?.kind === "path" && trigger.query.trim()),
    skills,
    isLoading:
      trigger?.kind === "pull-request"
        ? pullRequestSearch.isPending
        : pathSearch.isPending || threadSearch.isPending,
    error:
      trigger?.kind === "pull-request"
        ? pullRequestProjectId === null || pullRequestRepository === null
          ? "Pull requests are unavailable for this project."
          : pullRequestSearch.error
        : trigger?.kind === "path"
          ? pathSearch.error
          : null,
    onSelect,
  };
}
