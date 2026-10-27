import * as Dialog from "../../components/ui/Dialog";
import type {
  EnvironmentId,
  ProjectId,
  ProviderInteractionMode,
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
import { COMPOSER_CONTEXT_MAX_RECORDS } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import {
  environmentComposerContext,
  pullRequestComposerContext,
  threadComposerContext,
} from "../../lib/composerContext";
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
  readonly allowInteractionMode: boolean;
  readonly selectedProviderStatus: Pick<
    ServerProvider,
    "driver" | "slashCommands" | "showInteractionModeToggle"
  > | null;
}): ComposerCommandItem[] {
  const query = input.query.toLowerCase();
  const allowInteractionMode =
    input.allowInteractionMode && input.selectedProviderStatus?.showInteractionModeToggle !== false;
  const builtIn = [
    {
      id: "cmd:model",
      type: "slash-command",
      command: "model",
      label: "/model",
      description: "Switch model",
    },
    {
      id: "cmd:plan",
      type: "slash-command",
      command: "plan",
      label: "/plan",
      description: "Switch to plan mode",
    },
    {
      id: "cmd:default",
      type: "slash-command",
      command: "default",
      label: "/default",
      description: "Switch to default mode",
    },
  ] satisfies ComposerCommandItem[];
  const items: ComposerCommandItem[] = builtIn.filter(
    (item) => item.command.includes(query) && (item.command === "model" || allowInteractionMode),
  );

  // Providers expand commands only at the start of a message. T3 commands
  // change local state and do not have this restriction.
  if (!input.atMessageStart) return items;
  for (const command of input.selectedProviderStatus?.slashCommands ?? []) {
    if (!command.name.toLowerCase().includes(query)) continue;
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

export function resolveComposerCommandSelection(input: {
  readonly draftMessage: string;
  readonly trigger: Pick<ComposerTrigger, "rangeStart" | "rangeEnd">;
  readonly item: ComposerCommandItem;
  readonly allowInteractionMode: boolean;
}): {
  readonly text: string;
  readonly cursor: number;
  readonly interactionMode: ProviderInteractionMode | null;
} {
  const { draftMessage, trigger, item } = input;
  if (
    input.allowInteractionMode &&
    item.type === "slash-command" &&
    (item.command === "plan" || item.command === "default")
  ) {
    return {
      ...replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, ""),
      interactionMode: item.command,
    };
  }

  let replacement = "";
  if (item.type === "path") {
    replacement = `${serializeComposerFileLink(item.path)} `;
  } else if (item.type === "skill") {
    replacement = `$${item.skill.name} `;
  } else if (item.type === "slash-command") {
    replacement = `/${item.command} `;
  } else if (item.type === "provider-slash-command") {
    replacement = `/${item.command.name} `;
  }
  return {
    ...replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, replacement),
    interactionMode: null,
  };
}

export function useComposerCommandMenu({
  draftMessage,
  ownerKey,
  environmentId,
  threadShells = EMPTY_THREAD_SHELLS,
  environments = EMPTY_ENVIRONMENTS,
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
  onUpdateInteractionMode,
  onUsageLimits,
}: {
  readonly draftMessage: string;
  readonly ownerKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly threadShells?: ReadonlyArray<EnvironmentThreadShell>;
  readonly environments?: ReadonlyArray<ComposerEnvironmentCandidate>;
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
  readonly onUpdateInteractionMode?: (mode: ProviderInteractionMode) => void;
  readonly onUsageLimits?: () => void;
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
  useThreadSearch(
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
        allowInteractionMode: onUpdateInteractionMode !== undefined,
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
            excludeThreadId: currentThreadId,
            query: trigger.query,
            now,
          })
        : [];
      const environmentItems = environmentId
        ? matchComposerEnvironmentItems({ environments, environmentId, query: trigger.query })
        : [];
      return [
        ...threadItems,
        ...environmentItems,
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
      const record = threadComposerContext(item.thread, shell.title);
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

    const result = resolveComposerCommandSelection({
      draftMessage,
      trigger,
      item,
      allowInteractionMode:
        onUpdateInteractionMode !== undefined &&
        selectedProviderStatus?.showInteractionModeToggle !== false,
    });
    setSelection({ start: result.cursor, end: result.cursor });
    onChangeDraftMessage(result.text);
    if (result.interactionMode !== null) {
      onUpdateInteractionMode?.(result.interactionMode);
    }
  };

  return {
    selection,
    onSelectionChange,
    trigger,
    items,
    skills,
    isLoading:
      trigger?.kind === "pull-request" ? pullRequestSearch.isPending : pathSearch.isPending,
    error:
      trigger?.kind === "pull-request"
        ? pullRequestProjectId === null || pullRequestRepository === null
          ? "Pull requests are unavailable for this project."
          : pullRequestSearch.error
        : null,
    onSelect,
  };
}
