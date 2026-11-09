import {
  matchComposerEnvironmentItems,
  matchComposerThreadItems,
} from "@t3tools/client-runtime/composerThreadItems";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import type {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  PullRequestListInput,
  ServerProvider,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { mentionSearchInput } from "@t3tools/client-runtime/state/mentions";
import {
  composerPullRequestsFromLinks,
  filterComposerPullRequestMatches,
  withLinkedComposerPullRequestsFirst,
} from "@t3tools/shared/composerPullRequestMatches";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";

import type { ComposerTrigger } from "../../composer-logic";
import type { DraftId } from "../../composerDraftStore";
import { basenameOfPath } from "../../pierre-icons";
import {
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
} from "@t3tools/client-runtime/providerSkills";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useVisibleThreadShells } from "~/state/entities";
import { useEnvironmentIdentities, useEnvironmentMachines } from "~/state/environments";
import { offersLinkedEnvironmentsAtom } from "~/state/peerLinks";
import {
  mentionIndexEnvironment,
  pullRequestEnvironment,
  usePullRequestList,
  type EnvironmentQueryTarget,
} from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useComposerPathSearch, useDebouncedValue, useThreadSearch } from "~/state/queries";
import {
  matchesPullRequestQuery,
  rankPullRequestMatches,
} from "../pullRequest/pullRequestList.logic";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { matchComposerModelItems } from "./composerModelMentions";
import type { ModelEsque } from "./providerIconUtils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  searchSlashCommandItems,
  slashCommandItemsForPromptPosition,
} from "./composerSlashCommandSearch";

const COMPOSER_PULL_REQUEST_RESULT_LIMIT = 12;
const COMPOSER_PULL_REQUEST_LIST_LIMIT = 99;
const EMPTY_PULL_REQUEST_LIST_TARGETS: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>> =
  [];

/** Builds the @, /, $ and # suggestion lists, running the searches each trigger needs. */
export function useComposerMenuItems({
  composerTrigger,
  environmentId,
  linkedEnvironments,
  gitCwd,
  activeThreadId,
  pullRequestProjectId,
  pullRequestRepository,
  threadPullRequests,
  sideChatAvailable,
  sideChatDisabledReason,
  freshSessionAvailable,
  compactSlashCommandAvailable,
  selectedProvider,
  selectedProviderSkills,
  selectedProviderSlashCommands,
  showSkillsInSlashMenu,
  workspaceSkillsScanning,
  questionAttachmentTarget,
  mentionIndexEnabled,
  modelMentions,
}: {
  readonly composerTrigger: ComposerTrigger | null;
  readonly environmentId: EnvironmentId;
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly gitCwd: string | null;
  readonly activeThreadId: ThreadId | null;
  readonly pullRequestProjectId: ProjectId | null;
  readonly pullRequestRepository: string | null;
  readonly threadPullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly sideChatAvailable: boolean;
  readonly sideChatDisabledReason: string | null;
  readonly freshSessionAvailable: boolean;
  readonly compactSlashCommandAvailable: boolean;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedProviderSkills: ServerProvider["skills"];
  readonly selectedProviderSlashCommands: ServerProvider["slashCommands"];
  readonly showSkillsInSlashMenu: boolean;
  readonly workspaceSkillsScanning: boolean;
  readonly questionAttachmentTarget: DraftId | null;
  readonly mentionIndexEnabled: boolean;
  readonly modelMentions: {
    readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
    readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  };
}) {
  // Thread mentions rank by recency as of when the composer mounted.
  const [now] = useState(() => Date.now());
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const wantsPullRequests =
    composerTriggerKind === "pull-request" || composerTriggerKind === "hash";
  const wantsIssues =
    mentionIndexEnabled && (composerTriggerKind === "issue" || composerTriggerKind === "hash");
  const wantsThreads = composerTriggerKind === "path" || composerTriggerKind === "thread";
  const wantsFiles = composerTriggerKind === "path" || composerTriggerKind === "file";
  const pathTriggerQuery =
    composerTriggerKind === "path" || composerTriggerKind === "file"
      ? (composerTrigger?.query ?? "")
      : "";
  const pullRequestTriggerQuery = wantsPullRequests ? (composerTrigger?.query ?? "") : "";
  const pullRequestTextQuery =
    wantsPullRequests &&
    pullRequestTriggerQuery.length > 0 &&
    !/^\d+$/u.test(pullRequestTriggerQuery)
      ? pullRequestTriggerQuery
      : null;
  const debouncedPullRequestTextQuery = useDebouncedValue(pullRequestTextQuery, 180);
  const settledPullRequestTextQuery =
    pullRequestTextQuery === debouncedPullRequestTextQuery ? pullRequestTextQuery : null;
  const threadTriggerQuery = wantsThreads ? (composerTrigger?.query ?? "") : "";
  const environmentThreadShells = useVisibleThreadShells(wantsThreads);
  // Mounts older settled threads matching the mention, which shells may leave out.
  useThreadSearch(wantsThreads ? [environmentId] : [], threadTriggerQuery, {
    titlesOnly: true,
  });
  // The user's machines feed bare `@` machine matches; the catalog summary is cheap and stable.
  const environmentIdentities = useEnvironmentIdentities();
  const environmentMachines = useEnvironmentMachines();
  const offersMachines = useAtomValue(offersLinkedEnvironmentsAtom(environmentId));
  const mentionableEnvironments = environmentIdentities.map((identity) => ({
    ...identity,
    machine: environmentMachines.get(identity.environmentId) ?? ("server" as const),
  }));
  const workspaceEntries = useComposerPathSearch({
    environmentId,
    cwd: wantsFiles ? gitCwd : null,
    query: wantsFiles ? pathTriggerQuery : null,
  });

  const classicPullRequestListTargets =
    mentionIndexEnabled ||
    composerTriggerKind !== "pull-request" ||
    pullRequestProjectId === null ||
    (pullRequestTextQuery !== null && settledPullRequestTextQuery === null)
      ? EMPTY_PULL_REQUEST_LIST_TARGETS
      : [
          {
            environmentId,
            input: {
              state: "all" as const,
              projectId: pullRequestProjectId,
              limit: COMPOSER_PULL_REQUEST_LIST_LIMIT,
              ...(settledPullRequestTextQuery === null
                ? {}
                : { query: settledPullRequestTextQuery }),
            },
          },
        ];
  const classicPullRequestLookup = usePullRequestList(classicPullRequestListTargets);

  const mentionQueryForIndex = wantsPullRequests
    ? (settledPullRequestTextQuery ??
      (pullRequestTextQuery === null ? pullRequestTriggerQuery : null))
    : null;
  const mentionIndexLookup = useEnvironmentQuery(
    !mentionIndexEnabled ||
      !wantsPullRequests ||
      pullRequestProjectId === null ||
      mentionQueryForIndex === null
      ? null
      : mentionIndexEnvironment.search({
          environmentId,
          input: mentionSearchInput({
            projectId: pullRequestProjectId,
            query: mentionQueryForIndex,
            limit: COMPOSER_PULL_REQUEST_RESULT_LIMIT,
            providers: ["pull-request"],
          }),
        }),
  );
  const threadMentionQuery = wantsThreads ? threadTriggerQuery : null;
  const debouncedThreadMentionQuery = useDebouncedValue(threadMentionQuery, 180);
  const threadMentionIndexLookup = useEnvironmentQuery(
    !mentionIndexEnabled ||
      !wantsThreads ||
      pullRequestProjectId === null ||
      threadMentionQuery !== debouncedThreadMentionQuery
      ? null
      : mentionIndexEnvironment.search({
          environmentId,
          input: mentionSearchInput({
            projectId: pullRequestProjectId,
            query: debouncedThreadMentionQuery ?? "",
            limit: 12,
            providers: ["thread"],
          }),
        }),
  );
  const jiraTriggerQuery = composerTrigger?.kind === "jira" ? composerTrigger.query : "";
  const debouncedJiraTriggerQuery = useDebouncedValue(jiraTriggerQuery, 180);
  const jiraMentionIndexLookup = useEnvironmentQuery(
    !mentionIndexEnabled ||
      composerTriggerKind !== "jira" ||
      pullRequestProjectId === null ||
      jiraTriggerQuery !== debouncedJiraTriggerQuery
      ? null
      : mentionIndexEnvironment.search({
          environmentId,
          input: mentionSearchInput({
            projectId: pullRequestProjectId,
            query: debouncedJiraTriggerQuery,
            limit: 12,
            providers: ["jira"],
          }),
        }),
  );
  const figmaTriggerQuery = composerTrigger?.kind === "figma" ? composerTrigger.query : "";
  const debouncedFigmaTriggerQuery = useDebouncedValue(figmaTriggerQuery, 180);
  const figmaMentionIndexLookup = useEnvironmentQuery(
    !mentionIndexEnabled ||
      composerTriggerKind !== "figma" ||
      pullRequestProjectId === null ||
      figmaTriggerQuery !== debouncedFigmaTriggerQuery
      ? null
      : mentionIndexEnvironment.search({
          environmentId,
          input: mentionSearchInput({
            projectId: pullRequestProjectId,
            query: debouncedFigmaTriggerQuery,
            limit: 24,
            providers: ["figma"],
          }),
        }),
  );
  const issueTriggerQuery = wantsIssues ? (composerTrigger?.query ?? "") : "";
  const debouncedIssueTriggerQuery = useDebouncedValue(issueTriggerQuery, 180);
  const issueMentionIndexLookup = useEnvironmentQuery(
    !mentionIndexEnabled ||
      !wantsIssues ||
      pullRequestProjectId === null ||
      issueTriggerQuery !== debouncedIssueTriggerQuery
      ? null
      : mentionIndexEnvironment.search({
          environmentId,
          input: mentionSearchInput({
            projectId: pullRequestProjectId,
            query: debouncedIssueTriggerQuery,
            limit: 12,
            providers: ["issue"],
          }),
        }),
  );
  const pullRequestTriggerNumber = (() => {
    if (!wantsPullRequests || (composerTrigger?.query.length ?? 0) === 0) {
      return null;
    }
    const number = Number(composerTrigger?.query ?? "");
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  })();
  const debouncedPullRequestNumber = useDebouncedValue(pullRequestTriggerNumber, 180);
  const settledPullRequestNumber =
    pullRequestTriggerNumber === debouncedPullRequestNumber ? pullRequestTriggerNumber : null;
  const classicHasExactPullRequest =
    !mentionIndexEnabled &&
    settledPullRequestNumber !== null &&
    classicPullRequestLookup.data?.entries.some(
      (entry) =>
        entry.projectId === pullRequestProjectId &&
        entry.repository.trim().toLowerCase() === pullRequestRepository?.trim().toLowerCase() &&
        entry.number === settledPullRequestNumber,
    ) === true;
  const indexHasExactPullRequest =
    mentionIndexEnabled &&
    settledPullRequestNumber !== null &&
    mentionIndexLookup.data?.hits.some(
      (hit) =>
        hit.pullRequest !== undefined &&
        hit.pullRequest.projectId === pullRequestProjectId &&
        hit.pullRequest.repository.trim().toLowerCase() ===
          pullRequestRepository?.trim().toLowerCase() &&
        hit.pullRequest.number === settledPullRequestNumber,
    ) === true;
  const exactPullRequestLookup = useEnvironmentQuery(
    settledPullRequestNumber === null ||
      pullRequestProjectId === null ||
      pullRequestRepository === null ||
      classicHasExactPullRequest ||
      indexHasExactPullRequest
      ? null
      : pullRequestEnvironment.detail({
          environmentId,
          input: {
            projectId: pullRequestProjectId,
            repository: pullRequestRepository,
            number: settledPullRequestNumber,
          },
        }),
  );

  const linkedPullRequests =
    pullRequestProjectId === null
      ? []
      : composerPullRequestsFromLinks(threadPullRequests ?? [], pullRequestProjectId);

  const items = ((): ComposerCommandItem[] => {
    if (!composerTrigger) return [];
    const threadItems = (): ComposerCommandItem[] => {
      const shellThreadItems = matchComposerThreadItems({
        shells: environmentThreadShells,
        environmentId,
        linkedEnvironments,
        excludeThreadId: activeThreadId,
        query: composerTrigger.query,
        now,
      });
      const shellThreadIds = new Set(shellThreadItems.map((item) => item.thread.threadId));
      const indexedThreadItems = (threadMentionIndexLookup.data?.hits ?? []).flatMap((hit) => {
        if (hit.thread === undefined) return [];
        if (shellThreadIds.has(hit.thread.threadId)) return [];
        if (activeThreadId !== null && hit.thread.threadId === activeThreadId) return [];
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
      workspaceEntries.entries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path" as const,
        path: entry.path,
        pathKind: entry.kind,
        searchTarget: workspaceEntries.searchedTarget,
        label: basenameOfPath(entry.path),
        description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
      }));
    const machineItems = (): ComposerCommandItem[] =>
      // An answer to an agent's question carries thread links, not machines.
      questionAttachmentTarget === null && offersMachines
        ? matchComposerEnvironmentItems({
            environments: mentionableEnvironments,
            environmentId,
            query: composerTrigger.query,
          })
        : [];
    if (composerTrigger.kind === "thread") return threadItems();
    if (composerTrigger.kind === "file") return fileItems();
    if (composerTrigger.kind === "path") {
      // Bare `@` keeps the classic mixed menu; `@thread:` / `@file:` filter by type.
      return [
        ...threadItems(),
        ...machineItems(),
        ...matchComposerModelItems({
          instanceEntries: modelMentions.instanceEntries,
          modelOptionsByInstance: modelMentions.modelOptionsByInstance,
          query: composerTrigger.query,
        }),
        ...fileItems(),
      ];
    }
    if (composerTrigger.kind === "jira") {
      // Question answers carry thread links, not Jira chips.
      if (questionAttachmentTarget !== null) return [];
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
    if (composerTrigger.kind === "figma") {
      // Question answers carry thread links, not Figma chips.
      if (questionAttachmentTarget !== null || pullRequestProjectId === null) return [];
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
            projectId: pullRequestProjectId,
            environmentId,
            label: hit.label,
            description: hit.description,
          },
        ];
      });
    }
    if (composerTrigger.kind === "slash-command") {
      const builtInSlashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        ...(sideChatAvailable
          ? ([
              {
                id: "slash:side",
                type: "slash-command",
                command: "side",
                label: "/side",
                description: sideChatDisabledReason ?? "Ask a side question in a new side chat",
              },
              {
                id: "slash:btw",
                type: "slash-command",
                command: "btw",
                label: "/btw",
                description: sideChatDisabledReason ?? "Same as /side",
              },
            ] as const)
          : []),
        ...(freshSessionAvailable
          ? ([
              {
                id: "slash:clear",
                type: "slash-command",
                command: "clear",
                label: "/clear",
                description: "Start a fresh session; earlier messages stay visible",
              },
            ] as const)
          : []),
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const slashMenuSkills = getProviderSkillsForSlashMenu(
        selectedProviderSkills,
        showSkillsInSlashMenu,
      );
      const providerSlashCommandItems = getProviderSlashCommandsForSlashMenu(
        selectedProviderSlashCommands,
        slashMenuSkills,
      ).map((command) => ({
        id: `provider-slash-command:${selectedProvider}:${command.name}`,
        type: "provider-slash-command" as const,
        provider: selectedProvider,
        command,
        label: `/${command.name}`,
        description: command.description ?? command.input?.hint ?? "Run provider command",
      }));
      const query = composerTrigger.query.trim().toLowerCase();
      const skillItems = slashMenuSkills.map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: `/skill:${skill.name}`,
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : ""),
      }));
      // T3's `/clear` replaces the provider's, which would clear a session T3 still treats as live.
      const visibleProviderSlashCommandItems = providerSlashCommandItems.filter(
        (item) =>
          (item.command.name !== "compact" || compactSlashCommandAvailable) &&
          (item.command.name !== "clear" || !freshSessionAvailable),
      );
      const slashCommandItems = slashCommandItemsForPromptPosition(
        [...builtInSlashCommandItems, ...visibleProviderSlashCommandItems, ...skillItems],
        composerTrigger.rangeStart === 0,
      );
      return searchSlashCommandItems(slashCommandItems, query);
    }
    if (composerTrigger.kind === "skill") {
      return searchProviderSkills(selectedProviderSkills, composerTrigger.query).map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: formatProviderSkillDisplayName(skill),
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
      }));
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
      const matches = mentionIndexEnabled
        ? withLinkedComposerPullRequestsFirst({
            matches: [
              ...exactPullRequest,
              ...(mentionIndexLookup.data?.hits ?? []).flatMap((hit) =>
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
            linked: linkedPullRequests,
            query: composerTrigger.query,
            limit: COMPOSER_PULL_REQUEST_RESULT_LIMIT,
          })
        : /^\d*$/u.test(composerTrigger.query)
          ? filterComposerPullRequestMatches({
              entries: [...exactPullRequest, ...(classicPullRequestLookup.data?.entries ?? [])],
              linked: linkedPullRequests,
              projectId: pullRequestProjectId,
              repository: pullRequestRepository,
              query: composerTrigger.query,
              limit: COMPOSER_PULL_REQUEST_RESULT_LIMIT,
            })
          : withLinkedComposerPullRequestsFirst({
              matches: rankPullRequestMatches(
                (classicPullRequestLookup.data?.entries ?? []).filter((entry) => {
                  if (
                    entry.projectId !== pullRequestProjectId ||
                    entry.repository.trim().toLowerCase() !==
                      pullRequestRepository.trim().toLowerCase()
                  ) {
                    return false;
                  }
                  const provider = classicPullRequestLookup.data?.providers.find(
                    (candidate) => candidate.host === entry.host,
                  );
                  return (
                    provider?.searchesOnHost === true ||
                    matchesPullRequestQuery(entry, composerTrigger.query)
                  );
                }),
                composerTrigger.query,
              ),
              linked: linkedPullRequests,
              query: composerTrigger.query,
              limit: COMPOSER_PULL_REQUEST_RESULT_LIMIT,
            });
      return matches.map((pullRequest) => ({
        id: `pull-request:${pullRequest.projectId}:${pullRequest.repository}:${pullRequest.number}`,
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
        description:
          pullRequest.repository.trim().toLowerCase() === pullRequestRepository.trim().toLowerCase()
            ? pullRequest.title
            : `${pullRequest.repository} · ${pullRequest.title}`,
      }));
    };

    // Question answers carry thread links, not PR/issue chips.
    if (questionAttachmentTarget !== null) return [];
    if (composerTrigger.kind === "issue") return issueItems();
    if (composerTrigger.kind === "pull-request") return pullRequestItems();
    if (composerTrigger.kind === "hash") return [...pullRequestItems(), ...issueItems()];
    return [];
  })();
  const mentionIndexSyncingEmpty =
    mentionIndexLookup.data?.status === "syncing" && mentionIndexLookup.data.hits.length === 0;
  const threadMentionIndexSyncingEmpty =
    threadMentionIndexLookup.data?.status === "syncing" &&
    threadMentionIndexLookup.data.hits.length === 0;
  const jiraMentionIndexSyncingEmpty =
    jiraMentionIndexLookup.data?.status === "syncing" &&
    jiraMentionIndexLookup.data.hits.length === 0;
  const figmaMentionIndexSyncingEmpty =
    figmaMentionIndexLookup.data?.status === "syncing" &&
    figmaMentionIndexLookup.data.hits.length === 0;
  const issueMentionIndexSyncingEmpty =
    issueMentionIndexLookup.data?.status === "syncing" &&
    issueMentionIndexLookup.data.hits.length === 0;
  // Cold index returns { hits: [], status: "syncing" }; keep querying until ready.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes a stale SWR mention-index read while the server finishes its first sync
  useEffect(() => {
    const refreshers: Array<() => void> = [];
    if (mentionIndexSyncingEmpty) refreshers.push(mentionIndexLookup.refresh);
    if (threadMentionIndexSyncingEmpty) refreshers.push(threadMentionIndexLookup.refresh);
    if (jiraMentionIndexSyncingEmpty) refreshers.push(jiraMentionIndexLookup.refresh);
    if (figmaMentionIndexSyncingEmpty) refreshers.push(figmaMentionIndexLookup.refresh);
    if (issueMentionIndexSyncingEmpty) refreshers.push(issueMentionIndexLookup.refresh);
    if (refreshers.length === 0) return;
    const interval = window.setInterval(() => {
      for (const refresh of refreshers) refresh();
    }, 750);
    return () => window.clearInterval(interval);
  }, [
    mentionIndexSyncingEmpty,
    threadMentionIndexSyncingEmpty,
    jiraMentionIndexSyncingEmpty,
    figmaMentionIndexSyncingEmpty,
    issueMentionIndexSyncingEmpty,
    mentionIndexLookup.refresh,
    threadMentionIndexLookup.refresh,
    jiraMentionIndexLookup.refresh,
    figmaMentionIndexLookup.refresh,
    issueMentionIndexLookup.refresh,
  ]);
  const isLoading =
    (wantsFiles && pathTriggerQuery.length > 0 && workspaceEntries.isPending) ||
    (mentionIndexEnabled &&
      wantsThreads &&
      (threadMentionIndexSyncingEmpty ||
        threadMentionIndexLookup.isPending ||
        threadMentionQuery !== debouncedThreadMentionQuery)) ||
    ((composerTriggerKind === "skill" || composerTriggerKind === "slash-command") &&
      workspaceSkillsScanning) ||
    (mentionIndexEnabled &&
      composerTriggerKind === "jira" &&
      pullRequestProjectId !== null &&
      (jiraMentionIndexLookup.isPending ||
        jiraMentionIndexSyncingEmpty ||
        jiraTriggerQuery !== debouncedJiraTriggerQuery)) ||
    (mentionIndexEnabled &&
      composerTriggerKind === "figma" &&
      pullRequestProjectId !== null &&
      (figmaMentionIndexLookup.isPending ||
        figmaMentionIndexSyncingEmpty ||
        figmaTriggerQuery !== debouncedFigmaTriggerQuery)) ||
    (wantsIssues &&
      pullRequestProjectId !== null &&
      (issueMentionIndexLookup.isPending ||
        issueMentionIndexSyncingEmpty ||
        issueTriggerQuery !== debouncedIssueTriggerQuery)) ||
    (wantsPullRequests &&
      pullRequestProjectId !== null &&
      pullRequestRepository !== null &&
      (pullRequestTextQuery !== debouncedPullRequestTextQuery ||
        pullRequestTriggerNumber !== debouncedPullRequestNumber ||
        exactPullRequestLookup.isPending ||
        (mentionIndexEnabled
          ? mentionIndexLookup.isPending || mentionIndexSyncingEmpty
          : classicPullRequestLookup.isPending)));
  const emptyState = (() => {
    if (composerTriggerKind === "skill") {
      return "No skills found. Try / to browse provider commands.";
    }
    if (composerTriggerKind === "thread") {
      return composerTrigger?.query
        ? `No thread matches ${composerTrigger.query}.`
        : "No matching threads.";
    }
    if (composerTriggerKind === "file") {
      return "No matching files or folders.";
    }
    if (composerTriggerKind === "jira") {
      if (pullRequestProjectId === null) {
        return "Jira search needs an open project.";
      }
      if (
        jiraMentionIndexLookup.error !== null ||
        jiraMentionIndexLookup.data?.status === "error"
      ) {
        return (
          jiraMentionIndexLookup.data?.detail ??
          "Jira issues could not be read. Set Jira spaces in Settings → Chat and configure a Jira MCP server."
        );
      }
      if (jiraMentionIndexLookup.data?.status === "empty") {
        return (
          jiraMentionIndexLookup.data.detail ??
          "No Jira issues indexed. Set Jira spaces in Settings → Chat and configure a Jira MCP server."
        );
      }
      return composerTrigger?.query
        ? `No Jira issue matches ${composerTrigger.query}.`
        : "No Jira issues found.";
    }
    if (composerTriggerKind === "figma") {
      if (pullRequestProjectId === null) {
        return "Figma search needs an open project.";
      }
      if (
        figmaMentionIndexLookup.error !== null ||
        figmaMentionIndexLookup.data?.status === "error"
      ) {
        return (
          figmaMentionIndexLookup.data?.detail ??
          "Figma designs could not be read. Add Figma files in Settings → Chat."
        );
      }
      if (figmaMentionIndexLookup.data?.status === "empty") {
        return (
          figmaMentionIndexLookup.data.detail ??
          "No Figma files indexed. Paste design links in Settings → Chat → Mentions."
        );
      }
      return composerTrigger?.query
        ? `No Figma design matches ${composerTrigger.query}.`
        : "No Figma designs found.";
    }
    if (composerTriggerKind === "issue") {
      if (pullRequestProjectId === null) {
        return "Issue search needs an open project.";
      }
      if (
        issueMentionIndexLookup.error !== null ||
        issueMentionIndexLookup.data?.status === "error"
      ) {
        return (
          issueMentionIndexLookup.data?.detail ??
          "GitHub issues could not be read for this project."
        );
      }
      if (issueMentionIndexLookup.data?.status === "empty") {
        return issueMentionIndexLookup.data.detail ?? "No GitHub issues indexed for this project.";
      }
      return composerTrigger?.query
        ? `No GitHub issue matches ${composerTrigger.query}.`
        : "No GitHub issues found.";
    }
    if (composerTriggerKind === "hash") {
      if (pullRequestProjectId === null || pullRequestRepository === null) {
        return "Pull requests and issues are not available for this project.";
      }
      if (mentionIndexLookup.error !== null || mentionIndexLookup.data?.status === "error") {
        return "Pull requests could not be read for this project.";
      }
      if (
        issueMentionIndexLookup.error !== null ||
        issueMentionIndexLookup.data?.status === "error"
      ) {
        return (
          issueMentionIndexLookup.data?.detail ??
          "GitHub issues could not be read for this project."
        );
      }
      return composerTrigger?.query
        ? `No pull request or issue matches ${composerTrigger.query}.`
        : "No pull requests or issues found.";
    }
    if (composerTriggerKind === "pull-request") {
      if (pullRequestProjectId === null || pullRequestRepository === null) {
        return "Pull requests are not available for this project.";
      }
      if (
        mentionIndexEnabled &&
        (mentionIndexLookup.error !== null || mentionIndexLookup.data?.status === "error")
      ) {
        return "Pull requests could not be read for this project.";
      }
      if (!mentionIndexEnabled && classicPullRequestLookup.error !== null) {
        return "Pull requests could not be read for this project.";
      }
      return composerTrigger?.query
        ? `No pull request matches ${composerTrigger.query}.`
        : "No pull requests found in this repository.";
    }
    return composerTriggerKind === "path"
      ? "No matching threads, machines, or files."
      : "No matching command.";
  })();

  return { items, isLoading, emptyState };
}
