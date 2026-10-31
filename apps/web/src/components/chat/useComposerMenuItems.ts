import {
  matchComposerEnvironmentItems,
  matchComposerThreadItems,
} from "@t3tools/client-runtime/composerThreadItems";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  RepoReferenceSearchInput,
  ServerProvider,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  filterComposerRepoReferenceMatches,
  linkedComposerPullRequestReferences,
  withLinkedComposerRepoReferencesFirst,
} from "@t3tools/shared/composerRepoReferenceMatches";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";

import type { ComposerTrigger } from "../../composer-logic";
import type { DraftId } from "../../composerDraftStore";
import { basenameOfPath } from "../../pierre-icons";
import {
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
} from "@t3tools/client-runtime/providerSkills";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useThreadShells } from "~/state/entities";
import { useEnvironmentIdentities, useEnvironmentMachines } from "~/state/environments";
import { offersLinkedEnvironmentsAtom } from "~/state/peerLinks";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useComposerPathSearch, useDebouncedValue, useThreadSearch } from "~/state/queries";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  searchSlashCommandItems,
  slashCommandItemsForPromptPosition,
} from "./composerSlashCommandSearch";

const COMPOSER_HASH_REFERENCE_RESULT_LIMIT = 12;

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
  planModeUiEnabled,
  sideChatAvailable,
  sideChatDisabledReason,
  compactSlashCommandAvailable,
  selectedProvider,
  selectedProviderSkills,
  selectedProviderSlashCommands,
  showSkillsInSlashMenu,
  questionAttachmentTarget,
}: {
  readonly composerTrigger: ComposerTrigger | null;
  readonly environmentId: EnvironmentId;
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly gitCwd: string | null;
  readonly activeThreadId: ThreadId | null;
  readonly pullRequestProjectId: ProjectId | null;
  readonly pullRequestRepository: string | null;
  readonly threadPullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly planModeUiEnabled: boolean;
  readonly sideChatAvailable: boolean;
  readonly sideChatDisabledReason: string | null;
  readonly compactSlashCommandAvailable: boolean;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedProviderSkills: ServerProvider["skills"];
  readonly selectedProviderSlashCommands: ServerProvider["slashCommands"];
  readonly showSkillsInSlashMenu: boolean;
  readonly questionAttachmentTarget: DraftId | null;
}) {
  // Thread mentions rank by recency as of when the composer mounted.
  const [now] = useState(() => Date.now());
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const hashReferenceTriggerQuery =
    composerTrigger?.kind === "hash-reference" ? composerTrigger.query : "";
  const hashReferenceTextQuery =
    composerTriggerKind === "hash-reference" &&
    hashReferenceTriggerQuery.length > 0 &&
    !/^\d+$/u.test(hashReferenceTriggerQuery)
      ? hashReferenceTriggerQuery
      : null;
  const debouncedHashReferenceTextQuery = useDebouncedValue(hashReferenceTextQuery, 180);
  const settledHashReferenceTextQuery =
    hashReferenceTextQuery === debouncedHashReferenceTextQuery ? hashReferenceTextQuery : null;
  const isPathTrigger = composerTriggerKind === "path";
  const environmentThreadShells = useThreadShells(isPathTrigger);
  // Mounts older settled threads matching the mention, which shells may leave out.
  useThreadSearch(isPathTrigger ? [environmentId] : [], pathTriggerQuery, { titlesOnly: true });
  // The user's machines feed `@` machine matches; the catalog summary is cheap and stable.
  const environmentIdentities = useEnvironmentIdentities();
  const environmentMachines = useEnvironmentMachines();
  const offersMachines = useAtomValue(offersLinkedEnvironmentsAtom(environmentId));
  const mentionableEnvironments = environmentIdentities.map((identity) => ({
    ...identity,
    machine: environmentMachines.get(identity.environmentId) ?? ("server" as const),
  }));
  const workspaceEntries = useComposerPathSearch({
    environmentId,
    cwd: isPathTrigger ? gitCwd : null,
    query: isPathTrigger ? pathTriggerQuery : null,
  });

  const hashReferenceNumber = (() => {
    if (composerTrigger?.kind !== "hash-reference" || composerTrigger.query.length === 0) {
      return null;
    }
    const number = Number(composerTrigger.query);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  })();
  const debouncedHashReferenceNumber = useDebouncedValue(hashReferenceNumber, 180);
  const settledHashReferenceNumber =
    hashReferenceNumber === debouncedHashReferenceNumber ? hashReferenceNumber : null;

  const hashReferenceSearchInput: RepoReferenceSearchInput | null =
    composerTriggerKind !== "hash-reference" ||
    pullRequestProjectId === null ||
    pullRequestRepository === null ||
    (hashReferenceTextQuery !== null && settledHashReferenceTextQuery === null) ||
    (hashReferenceNumber !== null && settledHashReferenceNumber === null)
      ? null
      : {
          projectId: pullRequestProjectId,
          repository: pullRequestRepository,
          limit: COMPOSER_HASH_REFERENCE_RESULT_LIMIT,
          ...(settledHashReferenceTextQuery !== null
            ? { query: settledHashReferenceTextQuery }
            : settledHashReferenceNumber !== null
              ? { query: String(settledHashReferenceNumber) }
              : {}),
        };
  const hashReferenceLookup = useEnvironmentQuery(
    hashReferenceSearchInput === null
      ? null
      : pullRequestEnvironment.searchReferences({
          environmentId,
          input: hashReferenceSearchInput,
        }),
  );

  const linkedPullRequests =
    pullRequestProjectId === null
      ? []
      : linkedComposerPullRequestReferences(threadPullRequests ?? [], pullRequestProjectId);

  const items = ((): ComposerCommandItem[] => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return [
        ...matchComposerThreadItems({
          shells: environmentThreadShells,
          environmentId,
          linkedEnvironments,
          excludeThreadId: activeThreadId,
          query: composerTrigger.query,
          now,
        }),
        // An answer to an agent's question carries thread links, not machines.
        ...(questionAttachmentTarget === null && offersMachines
          ? matchComposerEnvironmentItems({
              environments: mentionableEnvironments,
              environmentId,
              query: composerTrigger.query,
            })
          : []),
        ...workspaceEntries.entries.map((entry) => ({
          id: `path:${entry.kind}:${entry.path}`,
          type: "path" as const,
          path: entry.path,
          pathKind: entry.kind,
          searchTarget: workspaceEntries.searchedTarget,
          label: basenameOfPath(entry.path),
          description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
        })),
      ];
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
        ...(planModeUiEnabled
          ? ([
              {
                id: "slash:plan",
                type: "slash-command",
                command: "plan",
                label: "/plan",
                description: "Switch this thread into plan mode",
              },
              {
                id: "slash:default",
                type: "slash-command",
                command: "default",
                label: "/default",
                description: "Switch this thread back to normal build mode",
              },
            ] as const)
          : []),
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
      const visibleProviderSlashCommandItems = providerSlashCommandItems.filter(
        (item) => item.command.name !== "compact" || compactSlashCommandAvailable,
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
    if (
      composerTrigger.kind === "hash-reference" &&
      pullRequestProjectId !== null &&
      pullRequestRepository !== null
    ) {
      const entries = hashReferenceLookup.data?.entries ?? [];
      const matches = /^\d*$/u.test(composerTrigger.query)
        ? filterComposerRepoReferenceMatches({
            entries,
            linked: linkedPullRequests,
            projectId: pullRequestProjectId,
            repository: pullRequestRepository,
            query: composerTrigger.query,
            limit: COMPOSER_HASH_REFERENCE_RESULT_LIMIT,
          })
        : withLinkedComposerRepoReferencesFirst({
            matches: entries,
            linked: linkedPullRequests,
            query: composerTrigger.query,
            limit: COMPOSER_HASH_REFERENCE_RESULT_LIMIT,
          });
      return matches.flatMap((entry): ComposerCommandItem[] => {
        const label = `#${entry.number}`;
        const description =
          entry.repository.trim().toLowerCase() === pullRequestRepository.trim().toLowerCase()
            ? entry.title
            : `${entry.repository} · ${entry.title}`;
        if (entry.kind === "pull-request") {
          return [
            {
              id: `pull-request:${entry.projectId}:${entry.repository}:${entry.number}`,
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
              label,
              description,
            },
          ];
        }
        if (entry.kind === "issue") {
          return [
            {
              id: `issue:${entry.projectId}:${entry.repository}:${entry.number}`,
              type: "issue",
              issue: {
                number: entry.number,
                title: entry.title,
                url: entry.url,
                state: entry.state,
              },
              label,
              description,
            },
          ];
        }
        return [
          {
            id: `discussion:${entry.projectId}:${entry.repository}:${entry.number}`,
            type: "discussion",
            discussion: {
              number: entry.number,
              title: entry.title,
              url: entry.url,
              state: entry.state,
              ...(entry.category === undefined ? {} : { category: entry.category }),
            },
            label,
            description,
          },
        ];
      });
    }
    return [];
  })();
  const isLoading =
    (composerTriggerKind === "path" && pathTriggerQuery.length > 0 && workspaceEntries.isPending) ||
    (composerTriggerKind === "hash-reference" &&
      pullRequestProjectId !== null &&
      pullRequestRepository !== null &&
      (hashReferenceLookup.isPending ||
        hashReferenceTextQuery !== debouncedHashReferenceTextQuery ||
        hashReferenceNumber !== debouncedHashReferenceNumber));
  const emptyState = (() => {
    if (composerTriggerKind === "skill") {
      return "No skills found. Try / to browse provider commands.";
    }
    if (composerTriggerKind === "hash-reference") {
      if (pullRequestProjectId === null || pullRequestRepository === null) {
        return "References are not available for this project.";
      }
      if (
        hashReferenceLookup.error !== null ||
        (hashReferenceLookup.data?.errors.length ?? 0) > 0
      ) {
        return "References could not be read for this project.";
      }
      return composerTrigger?.query
        ? `No reference matches ${composerTrigger.query}.`
        : "No references found in this repository.";
    }
    return composerTriggerKind === "path"
      ? "No matching files or folders."
      : "No matching command.";
  })();

  return { items, isLoading, emptyState };
}
