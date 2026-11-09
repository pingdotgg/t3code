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
import {
  environmentComposerContext,
  figmaComposerContext,
  issueComposerContext,
  jiraComposerContext,
  pullRequestComposerContext,
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
import { mentionSearchInput } from "@t3tools/client-runtime/state/mentions";
import {
  composerPullRequestsFromLinks,
  withLinkedComposerPullRequestsFirst,
} from "@t3tools/shared/composerPullRequestMatches";
import { composerPullRequests, mentionIndexEnvironment } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";
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
  mentionIndexEnabled = false,
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
  readonly mentionIndexEnabled?: boolean;
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
    return detectComposerTrigger(draftMessage, selection.end, { mentionIndexEnabled });
  })();
  const wantsThreads = trigger?.kind === "path" || trigger?.kind === "thread";
  const wantsFiles = trigger?.kind === "path" || trigger?.kind === "file";
  const wantsPullRequests = trigger?.kind === "pull-request" || trigger?.kind === "hash";
  const wantsIssues =
    mentionIndexEnabled && (trigger?.kind === "issue" || trigger?.kind === "hash");
  const pathSearch = useComposerPathSearch({
    environmentId,
    cwd: wantsFiles ? projectCwd : null,
    query: wantsFiles ? (trigger?.query ?? null) : null,
  });
  // Mounts older settled threads matching the mention, which shells may leave out.
  useThreadSearch(
    wantsThreads && environmentId ? [environmentId] : [],
    wantsThreads ? (trigger?.query ?? "") : "",
    { titlesOnly: true },
  );
  const pullRequestSearch = useComposerPullRequestSearch({
    environmentId,
    projectId: pullRequestProjectId,
    repository: pullRequestRepository,
    threadPullRequests,
    // Classic live list is empty when the mention index owns PR suggestions.
    query: mentionIndexEnabled || !wantsPullRequests ? null : (trigger?.query ?? null),
  });
  const pullRequestTriggerQuery = wantsPullRequests ? (trigger?.query ?? null) : null;
  const debouncedPullRequestTriggerQuery = useDebouncedValue(pullRequestTriggerQuery, 180);
  const prMentionIndexLookup = useEnvironmentQuery(
    !mentionIndexEnabled ||
      !wantsPullRequests ||
      environmentId === null ||
      pullRequestProjectId === null ||
      pullRequestTriggerQuery !== debouncedPullRequestTriggerQuery
      ? null
      : mentionIndexEnvironment.search({
          environmentId,
          input: mentionSearchInput({
            projectId: pullRequestProjectId,
            query: debouncedPullRequestTriggerQuery ?? "",
            limit: 12,
            providers: ["pull-request"],
          }),
        }),
  );
  const pullRequestTriggerNumber = (() => {
    if (!mentionIndexEnabled || !wantsPullRequests || (trigger?.query.length ?? 0) === 0) {
      return null;
    }
    const number = Number(trigger?.query ?? "");
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  })();
  const debouncedPullRequestNumber = useDebouncedValue(pullRequestTriggerNumber, 180);
  const settledPullRequestNumber =
    pullRequestTriggerNumber === debouncedPullRequestNumber ? pullRequestTriggerNumber : null;
  const indexHasExactPullRequest =
    settledPullRequestNumber !== null &&
    prMentionIndexLookup.data?.hits.some(
      (hit) =>
        hit.pullRequest !== undefined &&
        hit.pullRequest.projectId === pullRequestProjectId &&
        hit.pullRequest.repository.trim().toLowerCase() ===
          pullRequestRepository?.trim().toLowerCase() &&
        hit.pullRequest.number === settledPullRequestNumber,
    ) === true;
  const exactPullRequestLookup = useEnvironmentQuery(
    !mentionIndexEnabled ||
      settledPullRequestNumber === null ||
      environmentId === null ||
      pullRequestProjectId === null ||
      pullRequestRepository === null ||
      indexHasExactPullRequest
      ? null
      : composerPullRequests.detail({
          environmentId,
          input: {
            projectId: pullRequestProjectId,
            repository: pullRequestRepository,
            number: settledPullRequestNumber,
          },
        }),
  );
  const jiraTriggerQuery = trigger?.kind === "jira" ? trigger.query : null;
  const debouncedJiraTriggerQuery = useDebouncedValue(jiraTriggerQuery, 180);
  const jiraMentionIndexLookup = useEnvironmentQuery(
    !mentionIndexEnabled ||
      trigger?.kind !== "jira" ||
      environmentId === null ||
      pullRequestProjectId === null ||
      jiraTriggerQuery !== debouncedJiraTriggerQuery
      ? null
      : mentionIndexEnvironment.search({
          environmentId,
          input: mentionSearchInput({
            projectId: pullRequestProjectId,
            query: debouncedJiraTriggerQuery ?? "",
            limit: 12,
            providers: ["jira"],
          }),
        }),
  );
  const figmaTriggerQuery = trigger?.kind === "figma" ? trigger.query : null;
  const debouncedFigmaTriggerQuery = useDebouncedValue(figmaTriggerQuery, 180);
  const figmaMentionIndexLookup = useEnvironmentQuery(
    !mentionIndexEnabled ||
      trigger?.kind !== "figma" ||
      environmentId === null ||
      pullRequestProjectId === null ||
      figmaTriggerQuery !== debouncedFigmaTriggerQuery
      ? null
      : mentionIndexEnvironment.search({
          environmentId,
          input: mentionSearchInput({
            projectId: pullRequestProjectId,
            query: debouncedFigmaTriggerQuery ?? "",
            limit: 24,
            providers: ["figma"],
          }),
        }),
  );
  const issueTriggerQuery = wantsIssues ? (trigger?.query ?? null) : null;
  const debouncedIssueTriggerQuery = useDebouncedValue(issueTriggerQuery, 180);
  const issueMentionIndexLookup = useEnvironmentQuery(
    !mentionIndexEnabled ||
      !wantsIssues ||
      environmentId === null ||
      pullRequestProjectId === null ||
      issueTriggerQuery !== debouncedIssueTriggerQuery
      ? null
      : mentionIndexEnvironment.search({
          environmentId,
          input: mentionSearchInput({
            projectId: pullRequestProjectId,
            query: debouncedIssueTriggerQuery ?? "",
            limit: 12,
            providers: ["issue"],
          }),
        }),
  );
  const threadTriggerQuery = wantsThreads ? (trigger?.query ?? null) : null;
  const debouncedThreadTriggerQuery = useDebouncedValue(threadTriggerQuery, 180);
  const threadMentionIndexLookup = useEnvironmentQuery(
    !mentionIndexEnabled ||
      !wantsThreads ||
      environmentId === null ||
      pullRequestProjectId === null ||
      threadTriggerQuery !== debouncedThreadTriggerQuery
      ? null
      : mentionIndexEnvironment.search({
          environmentId,
          input: mentionSearchInput({
            projectId: pullRequestProjectId,
            query: debouncedThreadTriggerQuery ?? "",
            limit: 12,
            providers: ["thread"],
          }),
        }),
  );

  const items = ((): ComposerCommandItem[] => {
    if (!trigger) return [];

    if (trigger.kind === "jira") {
      return (jiraMentionIndexLookup.data?.hits ?? []).flatMap((hit) => {
        if (hit.jira === undefined) return [];
        return [
          {
            id: `jira:${hit.jira.key}`,
            type: "jira" as const,
            key: hit.jira.key,
            url: hit.jira.url,
            summary: hit.jira.summary,
            label: hit.label,
            description:
              hit.jira.status !== undefined
                ? `${hit.jira.status} · ${hit.description}`
                : hit.description,
          },
        ];
      });
    }

    if (trigger.kind === "figma") {
      return (figmaMentionIndexLookup.data?.hits ?? []).flatMap((hit) => {
        if (hit.figma === undefined) return [];
        return [
          {
            id: `figma:${hit.figma.fileKey}`,
            type: "figma" as const,
            fileKey: hit.figma.fileKey,
            url: hit.figma.url,
            name: hit.figma.name,
            hasThumbnail: hit.figma.hasThumbnail,
            label: hit.label,
            description: hit.description,
          },
        ];
      });
    }

    const issueItems = (): ComposerCommandItem[] =>
      (issueMentionIndexLookup.data?.hits ?? []).flatMap((hit) => {
        if (hit.issue === undefined) return [];
        return [
          {
            id: `issue:${hit.issue.repository.toLowerCase()}#${hit.issue.number}`,
            type: "issue" as const,
            number: hit.issue.number,
            title: hit.issue.title,
            url: hit.issue.url,
            repository: hit.issue.repository,
            state: hit.issue.state,
            label: hit.label,
            description: `${hit.issue.state} · ${hit.issue.repository} · ${hit.description}`,
          },
        ];
      });

    const pullRequestItems = (): ComposerCommandItem[] => {
      if (mentionIndexEnabled) {
        if (pullRequestProjectId === null || pullRequestRepository === null) return [];
        const exactPullRequest =
          exactPullRequestLookup.data?.number === pullRequestTriggerNumber
            ? [
                {
                  projectId: pullRequestProjectId,
                  repository: pullRequestRepository,
                  number: exactPullRequestLookup.data.number,
                  title: exactPullRequestLookup.data.title,
                  url: exactPullRequestLookup.data.url,
                  headBranch: exactPullRequestLookup.data.headBranch,
                  baseBranch: exactPullRequestLookup.data.baseBranch,
                  state: exactPullRequestLookup.data.state,
                  isDraft: exactPullRequestLookup.data.isDraft ?? false,
                  updatedAt: exactPullRequestLookup.data.updatedAt,
                },
              ]
            : [];
        const linked = composerPullRequestsFromLinks(
          threadPullRequests ?? [],
          pullRequestProjectId,
        );
        const matches = withLinkedComposerPullRequestsFirst({
          matches: [
            ...exactPullRequest,
            ...(prMentionIndexLookup.data?.hits ?? []).flatMap((hit) =>
              hit.pullRequest === undefined
                ? []
                : [
                    {
                      projectId: hit.pullRequest.projectId,
                      repository: hit.pullRequest.repository,
                      number: hit.pullRequest.number,
                      title: hit.pullRequest.title,
                      url: hit.pullRequest.url,
                      headBranch: hit.pullRequest.headBranch,
                      baseBranch: hit.pullRequest.baseBranch,
                      state: hit.pullRequest.state,
                      isDraft: hit.pullRequest.isDraft,
                      updatedAt: "",
                    },
                  ],
            ),
          ],
          linked,
          query: trigger.query,
          limit: 12,
        });
        return matches.map((pullRequest) => ({
          id: `pr:${pullRequest.projectId}:${pullRequest.repository}:${pullRequest.number}`,
          type: "pull-request" as const,
          pullRequest: {
            number: pullRequest.number,
            title: pullRequest.title,
            url: pullRequest.url,
            headBranch: pullRequest.headBranch,
            baseBranch: pullRequest.baseBranch,
            state: pullRequest.state,
            isDraft: pullRequest.isDraft,
          },
          label: `#${pullRequest.number}`,
          description: `${pullRequest.isDraft ? "Draft" : pullRequest.state} · ${
            pullRequest.repository.toLowerCase() === pullRequestRepository.toLowerCase()
              ? ""
              : `${pullRequest.repository} · `
          }${pullRequest.title}`,
        }));
      }
      return pullRequestSearch.entries.map((entry) => ({
        id: `pr:${entry.projectId}:${entry.repository}:${entry.number}`,
        type: "pull-request" as const,
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
    };

    if (trigger.kind === "issue") return issueItems();
    if (trigger.kind === "pull-request") return pullRequestItems();
    if (trigger.kind === "hash") return [...pullRequestItems(), ...issueItems()];

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

    const threadItems = (): ComposerCommandItem[] => {
      if (!environmentId) return [];
      const shellThreadItems = matchComposerThreadItems({
        shells: threadShells,
        environmentId,
        linkedEnvironments,
        excludeThreadId: currentThreadId,
        query: trigger.query,
        now,
      });
      const shellThreadIds = new Set(shellThreadItems.map((item) => item.thread.threadId));
      const indexedThreadItems = (threadMentionIndexLookup.data?.hits ?? []).flatMap((hit) => {
        if (hit.thread === undefined) return [];
        if (shellThreadIds.has(hit.thread.threadId)) return [];
        if (currentThreadId !== null && hit.thread.threadId === currentThreadId) return [];
        return [
          {
            id: `thread-index:${hit.thread.environmentId}:${hit.thread.threadId}`,
            type: "thread" as const,
            thread: {
              environmentId: hit.thread.environmentId,
              threadId: hit.thread.threadId,
            },
            label: hit.label,
            description: hit.description,
          },
        ];
      });
      return [...shellThreadItems, ...indexedThreadItems];
    };
    const fileItems = (): ComposerCommandItem[] =>
      pathSearch.entries.map((entry) => {
        const parts = entry.path.split("/");
        return {
          id: `path:${entry.path}`,
          type: "path" as const,
          path: entry.path,
          kind: entry.kind,
          label: parts[parts.length - 1] ?? entry.path,
          description: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
        };
      });
    const machineItems = (): ComposerCommandItem[] =>
      environmentId
        ? matchComposerEnvironmentItems({ environments, environmentId, query: trigger.query })
        : [];
    if (trigger.kind === "thread") return threadItems();
    if (trigger.kind === "file") return fileItems();
    if (trigger.kind === "path") {
      // Bare `@` keeps the classic mixed menu; `@thread:` / `@file:` filter by type.
      const modelItems =
        modelOptions && modelProviders
          ? buildComposerModelItems(modelOptions, trigger.query, modelProviders)
          : [];
      return [...threadItems(), ...machineItems(), ...modelItems, ...fileItems()];
    }

    return [];
  })();

  const onSelect = (item: ComposerCommandItem) => {
    if (!trigger) return;
    if (item.type === "environment") {
      if (!ownerKey || trigger.kind !== "path") return; // machines stay on bare `@` only
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
      if (!ownerKey || (trigger.kind !== "path" && trigger.kind !== "thread")) return;
      const shell = threadShells.find(
        (candidate) =>
          candidate.environmentId === item.thread.environmentId &&
          candidate.id === item.thread.threadId,
      );
      const record = threadContextRecord(item.thread, shell?.title ?? item.label);
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
        (trigger.kind !== "pull-request" && trigger.kind !== "hash") ||
        !items.some((candidate) => candidate.id === item.id)
      )
        return;
      const record = pullRequestComposerContext(item.pullRequest, uuidv4());
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
    if (item.type === "jira") {
      if (
        !ownerKey ||
        trigger.kind !== "jira" ||
        !items.some((candidate) => candidate.id === item.id)
      ) {
        return;
      }
      const record = jiraComposerContext({
        key: item.key,
        url: item.url,
        summary: item.summary,
      });
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
    if (item.type === "figma") {
      if (
        !ownerKey ||
        trigger.kind !== "figma" ||
        !items.some((candidate) => candidate.id === item.id)
      ) {
        return;
      }
      const record = figmaComposerContext({
        fileKey: item.fileKey,
        url: item.url,
        name: item.name,
      });
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
    if (item.type === "issue") {
      if (
        !ownerKey ||
        (trigger.kind !== "issue" && trigger.kind !== "hash") ||
        !items.some((candidate) => candidate.id === item.id)
      ) {
        return;
      }
      const record = issueComposerContext({
        number: item.number,
        title: item.title,
        url: item.url,
        repository: item.repository,
        state: item.state,
      });
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

  const prMentionIndexSyncingEmpty =
    prMentionIndexLookup.data?.status === "syncing" && prMentionIndexLookup.data.hits.length === 0;
  const jiraMentionIndexSyncingEmpty =
    jiraMentionIndexLookup.data?.status === "syncing" &&
    jiraMentionIndexLookup.data.hits.length === 0;
  const figmaMentionIndexSyncingEmpty =
    figmaMentionIndexLookup.data?.status === "syncing" &&
    figmaMentionIndexLookup.data.hits.length === 0;
  const issueMentionIndexSyncingEmpty =
    issueMentionIndexLookup.data?.status === "syncing" &&
    issueMentionIndexLookup.data.hits.length === 0;
  const threadMentionIndexSyncingEmpty =
    threadMentionIndexLookup.data?.status === "syncing" &&
    threadMentionIndexLookup.data.hits.length === 0;
  // Cold index returns { hits: [], status: "syncing" }; keep querying until ready.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes a stale SWR mention-index read while the server finishes its first sync
  useEffect(() => {
    const refreshers: Array<() => void> = [];
    if (threadMentionIndexSyncingEmpty) refreshers.push(threadMentionIndexLookup.refresh);
    if (prMentionIndexSyncingEmpty) refreshers.push(prMentionIndexLookup.refresh);
    if (jiraMentionIndexSyncingEmpty) refreshers.push(jiraMentionIndexLookup.refresh);
    if (figmaMentionIndexSyncingEmpty) refreshers.push(figmaMentionIndexLookup.refresh);
    if (issueMentionIndexSyncingEmpty) refreshers.push(issueMentionIndexLookup.refresh);
    if (refreshers.length === 0) return;
    const interval = setInterval(() => {
      for (const refresh of refreshers) refresh();
    }, 750);
    return () => clearInterval(interval);
  }, [
    threadMentionIndexSyncingEmpty,
    prMentionIndexSyncingEmpty,
    jiraMentionIndexSyncingEmpty,
    figmaMentionIndexSyncingEmpty,
    issueMentionIndexSyncingEmpty,
    threadMentionIndexLookup.refresh,
    prMentionIndexLookup.refresh,
    jiraMentionIndexLookup.refresh,
    figmaMentionIndexLookup.refresh,
    issueMentionIndexLookup.refresh,
  ]);

  const pullRequestIndexPending =
    mentionIndexEnabled &&
    wantsPullRequests &&
    (prMentionIndexLookup.isPending ||
      prMentionIndexSyncingEmpty ||
      pullRequestTriggerQuery !== debouncedPullRequestTriggerQuery ||
      pullRequestTriggerNumber !== debouncedPullRequestNumber ||
      exactPullRequestLookup.isPending);
  const pullRequestIndexError =
    mentionIndexEnabled &&
    (prMentionIndexLookup.error !== null || prMentionIndexLookup.data?.status === "error")
      ? "Pull requests could not be read for this project."
      : null;

  return {
    selection,
    onSelectionChange,
    trigger,
    items,
    skills,
    isLoading:
      wantsPullRequests || wantsIssues
        ? (wantsPullRequests &&
            (mentionIndexEnabled ? pullRequestIndexPending : pullRequestSearch.isPending)) ||
          (wantsIssues &&
            (issueMentionIndexLookup.isPending ||
              issueMentionIndexSyncingEmpty ||
              issueTriggerQuery !== debouncedIssueTriggerQuery))
        : trigger?.kind === "jira"
          ? jiraMentionIndexLookup.isPending ||
            jiraMentionIndexSyncingEmpty ||
            jiraTriggerQuery !== debouncedJiraTriggerQuery
          : trigger?.kind === "figma"
            ? figmaMentionIndexLookup.isPending ||
              figmaMentionIndexSyncingEmpty ||
              figmaTriggerQuery !== debouncedFigmaTriggerQuery
            : wantsThreads
              ? threadMentionIndexLookup.isPending ||
                threadMentionIndexSyncingEmpty ||
                threadTriggerQuery !== debouncedThreadTriggerQuery ||
                (wantsFiles && pathSearch.isPending)
              : wantsFiles
                ? pathSearch.isPending
                : false,
    error:
      trigger?.kind === "hash"
        ? pullRequestProjectId === null || pullRequestRepository === null
          ? "Pull requests and issues are unavailable for this project."
          : mentionIndexEnabled
            ? (pullRequestIndexError ??
              (issueMentionIndexLookup.error !== null ||
              issueMentionIndexLookup.data?.status === "error"
                ? (issueMentionIndexLookup.data?.detail ??
                  "GitHub issues could not be read for this project.")
                : null))
            : pullRequestSearch.error
        : trigger?.kind === "pull-request"
          ? pullRequestProjectId === null || pullRequestRepository === null
            ? "Pull requests are unavailable for this project."
            : mentionIndexEnabled
              ? pullRequestIndexError
              : pullRequestSearch.error
          : trigger?.kind === "jira"
            ? pullRequestProjectId === null
              ? "Jira search needs an open project."
              : jiraMentionIndexLookup.error !== null ||
                  jiraMentionIndexLookup.data?.status === "error"
                ? (jiraMentionIndexLookup.data?.detail ??
                  "Jira issues could not be read. Set Jira spaces in Settings → Chat and configure a Jira MCP server.")
                : null
            : trigger?.kind === "figma"
              ? pullRequestProjectId === null
                ? "Figma search needs an open project."
                : figmaMentionIndexLookup.error !== null ||
                    figmaMentionIndexLookup.data?.status === "error"
                  ? (figmaMentionIndexLookup.data?.detail ??
                    "Figma designs could not be read. Add Figma files in Settings → Chat.")
                  : null
              : trigger?.kind === "issue"
                ? pullRequestProjectId === null
                  ? "Issue search needs an open project."
                  : issueMentionIndexLookup.error !== null ||
                      issueMentionIndexLookup.data?.status === "error"
                    ? (issueMentionIndexLookup.data?.detail ??
                      "GitHub issues could not be read for this project.")
                    : null
                : null,
    onSelect,
  };
}
