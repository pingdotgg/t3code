import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import type { ComposerPathSearchTarget } from "@t3tools/client-runtime/state/threads";
import {
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ProjectEntry,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type PullRequestContextMetadata,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import {
  BlocksIcon,
  CircleDotIcon,
  FolderIcon,
  MessagesSquareIcon,
  PackageIcon,
  SettingsIcon,
  TicketIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Command, CommandGroup, CommandItem, CommandList } from "../ui/command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ComposerBanner } from "./ComposerBanner";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { mentionIndexEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      searchTarget: ComposerPathSearchTarget;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-slash-command";
      provider: ProviderDriverKind;
      command: ServerProviderSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      provider: ProviderDriverKind;
      skill: ServerProviderSkill;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "pull-request";
      pullRequest: PullRequestContextMetadata;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "thread";
      thread: ScopedThreadRef;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "jira";
      key: string;
      url: string;
      summary: string;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "figma";
      fileKey: string;
      url: string;
      name: string;
      hasThumbnail: boolean;
      projectId: import("@t3tools/contracts").ProjectId;
      environmentId: EnvironmentId;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "issue";
      number: number;
      title: string;
      url: string;
      repository: string;
      state: "open" | "closed";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "environment";
      environmentId: EnvironmentId;
      machine: EnvironmentMachineKind;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "model";
      instanceId: ProviderInstanceId;
      model: string;
      driverKind: ProviderDriverKind;
      providerDisplayName: string;
      acpRegistryAgentId: string | undefined;
      acpRegistryIconUrl: string | undefined;
      label: string;
      description: string;
    };

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  listId: string;
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  emptyStateText?: string;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the highlighted menu item's DOM node into view
  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <ComposerBanner.Surface
        ref={listRef}
        className="flex min-h-0 w-full flex-col overflow-hidden pb-(--chat-composer-attachment-overlap) **:data-[slot=command-item]:rounded-lg **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4"
        data-composer-command-drawer="true"
      >
        {props.items.length > 0 ? (
          props.triggerKind === "figma" ? (
            <CommandList
              id={props.listId}
              aria-label={LISTBOX_LABEL_BY_TRIGGER.figma}
              className="max-h-80 min-h-0 scroll-pb-6"
            >
              <CommandGroup>
                <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
                  {props.items.map((item) =>
                    item.type === "figma" ? (
                      <FigmaComposerCommandCard
                        key={item.id}
                        optionId={composerSuggestionOptionId(props.listId, item.id)}
                        item={item}
                        isActive={props.activeItemId === item.id}
                        onHighlight={props.onHighlightedItemChange}
                        onSelect={props.onSelect}
                      />
                    ) : null,
                  )}
                </div>
              </CommandGroup>
            </CommandList>
          ) : (
            <CommandList
              id={props.listId}
              aria-label={
                props.triggerKind ? LISTBOX_LABEL_BY_TRIGGER[props.triggerKind] : undefined
              }
              className="max-h-72 min-h-0 scroll-pb-6"
            >
              <CommandGroup>
                {props.items.map((item) => (
                  <ComposerCommandMenuItem
                    key={item.id}
                    optionId={composerSuggestionOptionId(props.listId, item.id)}
                    item={item}
                    triggerKind={props.triggerKind}
                    resolvedTheme={props.resolvedTheme}
                    isActive={props.activeItemId === item.id}
                    onHighlight={props.onHighlightedItemChange}
                    onSelect={props.onSelect}
                  />
                ))}
              </CommandGroup>
            </CommandList>
          )
        ) : (
          <div className="px-5 pt-3.5 pb-7">
            <p className="text-secondary-label text-xs">
              {props.isLoading
                ? props.triggerKind === "skill" || props.triggerKind === "slash-command"
                  ? "Searching workspace skills..."
                  : props.triggerKind === "pull-request"
                    ? "Finding pull request..."
                    : props.triggerKind === "hash"
                      ? "Finding pull requests and issues..."
                      : props.triggerKind === "jira"
                        ? "Finding Jira issues..."
                        : props.triggerKind === "figma"
                          ? "Finding Figma designs..."
                          : props.triggerKind === "issue"
                            ? "Finding GitHub issues..."
                            : props.triggerKind === "thread"
                              ? "Finding threads..."
                              : props.triggerKind === "path"
                                ? "Finding mentions..."
                                : "Searching workspace files..."
                : (props.emptyStateText ??
                  (props.triggerKind === "skill"
                    ? "No skills found. Try / to browse provider commands."
                    : props.triggerKind === "path"
                      ? "No matching threads, machines, or files."
                      : props.triggerKind === "file"
                        ? "No matching files or folders."
                        : props.triggerKind === "thread"
                          ? "No matching threads."
                          : props.triggerKind === "jira"
                            ? "No matching Jira issues."
                            : props.triggerKind === "figma"
                              ? "No matching Figma designs."
                              : props.triggerKind === "issue"
                                ? "No matching GitHub issues."
                                : props.triggerKind === "hash"
                                  ? "No matching pull requests or issues."
                                  : "No matching command."))}
            </p>
          </div>
        )}
      </ComposerBanner.Surface>
    </Command>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  optionId: string;
  item: ComposerCommandItem;
  triggerKind: ComposerTriggerKind | null;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const skillSourceKind =
    props.item.type === "skill" ? resolveProviderSkillSourceKind(props.item.skill) : null;
  const isSlashSkill =
    props.triggerKind === "slash-command" && props.item.type === "skill" ? props.item.skill : null;
  const pullRequestPresentation =
    props.item.type === "pull-request" ? resolvePullRequestState(props.item.pullRequest) : null;

  return (
    <CommandItem
      render={<div id={props.optionId} />}
      aria-selected={props.isActive}
      value={props.item.id}
      data-composer-item-id={props.item.id}
      active={props.isActive}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      {props.item.type === "path" ? (
        <PierreEntryIcon
          pathValue={props.item.path}
          kind={props.item.pathKind}
          theme={props.resolvedTheme}
        />
      ) : null}
      {props.item.type === "thread" ? (
        <MessagesSquareIcon aria-hidden="true" className="size-4 shrink-0 text-secondary-label" />
      ) : null}
      {props.item.type === "jira" ? (
        <TicketIcon aria-hidden="true" className="size-4 shrink-0 text-secondary-label" />
      ) : null}
      {props.item.type === "issue" ? (
        <CircleDotIcon aria-hidden="true" className="size-4 shrink-0 text-secondary-label" />
      ) : null}
      {props.item.type === "environment" ? (
        <EnvironmentMachineIcon
          kind={props.item.machine}
          aria-hidden="true"
          className="size-4 shrink-0 text-secondary-label"
        />
      ) : null}
      {props.item.type === "model" ? (
        <ProviderInstanceIcon
          driverKind={props.item.driverKind}
          displayName={props.item.providerDisplayName}
          acpRegistryAgentId={props.item.acpRegistryAgentId}
          acpRegistryIconUrl={props.item.acpRegistryIconUrl}
          className="size-4 shrink-0"
          iconClassName="size-4"
        />
      ) : null}
      {pullRequestPresentation ? (
        <pullRequestPresentation.Icon
          role="img"
          aria-label={pullRequestPresentation.label}
          className={cn("size-4 shrink-0", pullRequestPresentation.toneClassName)}
        />
      ) : null}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 max-w-[45%] shrink-0 truncate font-sans text-xs font-medium">
          {isSlashSkill ? (
            <>
              <span className="text-secondary-label">/skill:</span>
              {formatProviderSkillDisplayName(isSlashSkill)}
            </>
          ) : (
            props.item.label
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-secondary-label text-xs">
          {props.item.description}
        </span>
        {skillSourceKind ? (
          <SkillSourceBadge
            kind={skillSourceKind}
            showSkillSuffix={props.triggerKind === "skill"}
          />
        ) : null}
      </span>
    </CommandItem>
  );
});

export function composerSuggestionOptionId(listId: string, itemId: string): string {
  // JSON escapes lone UTF-16 surrogates before URI encoding without losing identity.
  return `${listId}-${encodeURIComponent(JSON.stringify(itemId))}`;
}

const FigmaComposerCommandCard = memo(function FigmaComposerCommandCard(props: {
  optionId: string;
  item: Extract<ComposerCommandItem, { type: "figma" }>;
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const fetchThumbnail = useAtomCommand(mentionIndexEnvironment.thumbnail, {
    reportFailure: false,
  });
  const [src, setSrc] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads a per-card thumbnail from the mention index once the menu shows the file
  useEffect(() => {
    if (!props.item.hasThumbnail) return;
    let cancelled = false;
    void fetchThumbnail({
      environmentId: props.item.environmentId,
      input: {
        projectId: props.item.projectId,
        providerId: "figma",
        itemKey: props.item.fileKey,
      },
    }).then((result) => {
      if (cancelled || result._tag !== "Success" || result.value._tag !== "Present") return;
      setSrc(`data:${result.value.mimeType};base64,${result.value.dataBase64}`);
    });
    return () => {
      cancelled = true;
    };
  }, [
    fetchThumbnail,
    props.item.environmentId,
    props.item.fileKey,
    props.item.hasThumbnail,
    props.item.projectId,
  ]);

  return (
    <CommandItem
      render={<div id={props.optionId} />}
      aria-selected={props.isActive}
      value={props.item.id}
      data-composer-item-id={props.item.id}
      active={props.isActive}
      className="flex h-auto flex-col items-stretch gap-1.5 overflow-hidden rounded-lg p-1.5!"
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      <div className="aspect-[4/3] w-full overflow-hidden rounded-md bg-muted">
        {src ? (
          <img src={src} alt="" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center text-3xs text-secondary-label">
            Figma
          </div>
        )}
      </div>
      <span className="w-full truncate px-0.5 text-left text-xs font-medium">
        {props.item.label}
      </span>
    </CommandItem>
  );
});

const LISTBOX_LABEL_BY_TRIGGER: Record<ComposerTriggerKind, string> = {
  path: "Threads, machines, and files",
  file: "Files and folders",
  thread: "Threads",
  "pull-request": "Pull requests",
  jira: "Jira issues",
  figma: "Figma designs",
  issue: "GitHub issues",
  hash: "Pull requests and issues",
  "slash-command": "Commands",
  skill: "Skills",
};

const SKILL_SOURCE_ICON_BY_KIND: Record<ProviderSkillSourceKind, LucideIcon> = {
  app: BlocksIcon,
  repo: FolderIcon,
  project: FolderIcon,
  personal: UserRoundIcon,
  system: SettingsIcon,
  other: PackageIcon,
};

const SKILL_SOURCE_LABEL_BY_KIND: Record<ProviderSkillSourceKind, string> = {
  app: "App",
  repo: "Repo",
  project: "Project",
  personal: "Personal",
  system: "System",
  other: "Provider",
};

function SkillSourceBadge(props: { kind: ProviderSkillSourceKind; showSkillSuffix: boolean }) {
  const Icon = SKILL_SOURCE_ICON_BY_KIND[props.kind];
  return (
    <Badge className="ms-auto" variant="secondary">
      <Icon aria-hidden="true" className="text-current" />
      {SKILL_SOURCE_LABEL_BY_KIND[props.kind]}
      {props.showSkillSuffix ? " Skill" : null}
    </Badge>
  );
}
