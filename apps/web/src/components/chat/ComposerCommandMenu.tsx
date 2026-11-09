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
  CornerLeftUpIcon,
  FolderDotIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderInputIcon,
  MessagesSquareIcon,
  PackageIcon,
  SettingsIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { Fragment, memo, useLayoutEffect, useRef } from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Command, CommandGroup, CommandItem, CommandList } from "../ui/command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import type { FolderMoveRow } from "./folderMoveDestinations";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ComposerBanner } from "./ComposerBanner";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";

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
      /** Why the command cannot run now. The description shows it without its final period. */
      blockReason?: string | undefined;
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
    }
  | (FolderMoveRow & { type: "folder-destination" });

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  listId: string;
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  emptyStateText?: string;
  /** A line above the rows, such as the folder a thread works in. */
  header?: string | undefined;
  /** A line below the rows, such as why a typed name matches none of them. */
  footer?: string | undefined;
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
        {props.header ? (
          <p className="wrap-anywhere px-5 pt-3 text-secondary-label text-xs">{props.header}</p>
        ) : null}
        {props.items.length > 0 ? (
          <CommandList
            id={props.listId}
            aria-label={props.triggerKind ? LISTBOX_LABEL_BY_TRIGGER[props.triggerKind] : undefined}
            className="max-h-72 min-h-0 scroll-pb-6"
          >
            <CommandGroup>
              {props.items.map((item, index) => {
                const group = item.type === "folder-destination" ? item.group : null;
                const previous = props.items[index - 1];
                const startsGroup =
                  group !== null &&
                  (previous?.type !== "folder-destination" || previous.group !== group);
                return (
                  <Fragment key={item.id}>
                    {startsGroup ? (
                      <div
                        role="presentation"
                        className="px-2 pt-2 pb-1 font-medium text-secondary-label text-xs"
                      >
                        {group}
                      </div>
                    ) : null}
                    <ComposerCommandMenuItem
                      optionId={composerSuggestionOptionId(props.listId, item.id)}
                      item={item}
                      triggerKind={props.triggerKind}
                      resolvedTheme={props.resolvedTheme}
                      isActive={props.activeItemId === item.id}
                      onHighlight={props.onHighlightedItemChange}
                      onSelect={props.onSelect}
                    />
                  </Fragment>
                );
              })}
            </CommandGroup>
          </CommandList>
        ) : (
          <div className="px-5 pt-3.5 pb-7">
            <p className="text-secondary-label text-xs">
              {props.isLoading
                ? props.triggerKind === "skill" || props.triggerKind === "slash-command"
                  ? "Searching workspace skills..."
                  : props.triggerKind === "pull-request"
                    ? "Finding pull request..."
                    : props.triggerKind === "folder"
                      ? "Loading folders..."
                      : "Searching workspace files..."
                : (props.emptyStateText ??
                  (props.triggerKind === "skill"
                    ? "No skills found. Try / to browse provider commands."
                    : props.triggerKind === "path"
                      ? "No matching files or folders."
                      : "No matching command."))}
            </p>
          </div>
        )}
        {props.footer && props.items.length > 0 ? (
          <p className="wrap-anywhere px-5 pt-1 pb-4 text-secondary-label text-xs">
            {props.footer}
          </p>
        ) : null}
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
  const FolderMoveIcon =
    props.item.type === "folder-destination" ? FOLDER_MOVE_ICON[props.item.icon] : null;
  // Not `disabled`: that drops pointer events, and a click must still show why the row is blocked.
  const blocked = props.item.type === "slash-command" && props.item.blockReason !== undefined;

  return (
    <CommandItem
      render={<div id={props.optionId} />}
      aria-selected={props.isActive}
      aria-disabled={blocked || undefined}
      className={blocked ? "opacity-64" : undefined}
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
      {FolderMoveIcon ? (
        <FolderMoveIcon aria-hidden="true" className="size-4 shrink-0 text-secondary-label" />
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
        {props.item.type === "folder-destination" &&
        props.item.group === "Folders" &&
        (props.item.isCurrent || props.item.isProject) ? (
          <Badge className="ms-auto" variant="secondary">
            {props.item.isCurrent ? "Current" : "Project"}
          </Badge>
        ) : null}
      </span>
    </CommandItem>
  );
});

export function composerSuggestionOptionId(listId: string, itemId: string): string {
  // JSON escapes lone UTF-16 surrogates before URI encoding without losing identity.
  return `${listId}-${encodeURIComponent(JSON.stringify(itemId))}`;
}

const LISTBOX_LABEL_BY_TRIGGER: Record<ComposerTriggerKind, string> = {
  path: "Files and folders",
  "pull-request": "Pull requests",
  "slash-command": "Commands",
  skill: "Skills",
  folder: "Destinations",
};

const FOLDER_MOVE_ICON: Record<FolderMoveRow["icon"], LucideIcon> = {
  project: FolderGit2Icon,
  folder: FolderIcon,
  parent: CornerLeftUpIcon,
  use: FolderInputIcon,
  "no-project": FolderDotIcon,
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
