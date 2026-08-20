import {
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import {
  type IssueListEntry,
  type ProjectEntry,
  type ProviderDriverKind,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import {
  BlocksIcon,
  FolderGit2Icon,
  FolderIcon,
  PackageIcon,
  SettingsIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useLayoutEffect, useRef } from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { cn } from "~/lib/utils";
import { IssueStateGlyph } from "../issue/issuePresentation";
import { Command, CommandGroup, CommandItem, CommandList } from "../ui/command";
import { PierreEntryIcon } from "./PierreEntryIcon";

export function composerIssueReference(issue: IssueListEntry): string {
  return issue.provider === "linear"
    ? `${issue.repository}-${issue.number}`
    : `${issue.repository}#${issue.number}`;
}

export function serializeComposerIssueMention(issue: IssueListEntry): string {
  return `[@${composerIssueReference(issue)}](${issue.url}) `;
}

export type ComposerCommandItem =
  | {
      id: string;
      type: "issue";
      issue: IssueListEntry;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
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
    };

export function buildComposerPathMenuItems(input: {
  issues: ReadonlyArray<IssueListEntry>;
  pathItems: ReadonlyArray<Extract<ComposerCommandItem, { type: "path" }>>;
  query: string;
  settledIssueQuery: string;
}): ComposerCommandItem[] {
  if (input.query !== input.settledIssueQuery) return [...input.pathItems];
  return [
    ...input.issues.slice(0, 8).map((issue) => ({
      id: `issue:${issue.provider}:${issue.host}:${issue.projectId}:${issue.repository}:${issue.number}`,
      type: "issue" as const,
      issue,
      label: issue.title,
      description: composerIssueReference(issue),
    })),
    ...input.pathItems,
  ];
}

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
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
      <div
        ref={listRef}
        className="chat-composer-drawer-surface chat-composer-drawer-attached relative w-full overflow-hidden **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4"
        data-composer-command-drawer="true"
      >
        {props.items.length > 0 ? (
          <CommandList className="max-h-72 scroll-pb-6">
            <CommandGroup>
              {props.items.map((item) => (
                <ComposerCommandMenuItem
                  key={item.id}
                  item={item}
                  resolvedTheme={props.resolvedTheme}
                  isActive={props.activeItemId === item.id}
                  onHighlight={props.onHighlightedItemChange}
                  onSelect={props.onSelect}
                />
              ))}
            </CommandGroup>
          </CommandList>
        ) : (
          <div className="px-5 pt-3.5 pb-7">
            <p className="text-secondary-label text-xs">
              {props.isLoading
                ? props.triggerKind === "skill"
                  ? "Searching workspace skills..."
                  : "Searching workspace..."
                : (props.emptyStateText ??
                  (props.triggerKind === "skill"
                    ? "No skills found. Try / to browse provider commands."
                    : props.triggerKind === "path"
                      ? "No matching files or folders."
                      : "No matching command."))}
            </p>
          </div>
        )}
      </div>
    </Command>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  item: ComposerCommandItem;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const skillSourceKind =
    props.item.type === "skill" ? resolveProviderSkillSourceKind(props.item.skill) : null;

  return (
    <CommandItem
      value={props.item.id}
      data-composer-item-id={props.item.id}
      className={cn(
        "cursor-pointer select-none gap-3 rounded-lg px-3 py-2! hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit",
        props.isActive && "bg-accent! text-accent-foreground!",
      )}
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
      {props.item.type === "issue" ? (
        <IssueStateGlyph
          state={props.item.issue.state}
          stateReason={props.item.issue.stateReason}
        />
      ) : props.item.type === "path" ? (
        <PierreEntryIcon
          pathValue={props.item.path}
          kind={props.item.pathKind}
          theme={props.resolvedTheme}
        />
      ) : skillSourceKind ? (
        <SkillSourceIcon kind={skillSourceKind} />
      ) : null}
      <span className="flex min-w-0 flex-1 items-baseline gap-3">
        <span
          className={cn(
            "font-sans text-xs font-medium",
            props.item.type === "issue" ? "min-w-0 flex-1 truncate" : "shrink-0",
          )}
        >
          {props.item.label}
        </span>
        <span
          className={cn(
            "text-right text-secondary-label text-xs",
            props.item.type === "issue" ? "shrink-0" : "min-w-0 flex-1 truncate",
          )}
        >
          {props.item.description}
        </span>
      </span>
    </CommandItem>
  );
});

const SKILL_SOURCE_ICON_BY_KIND: Record<ProviderSkillSourceKind, LucideIcon> = {
  app: BlocksIcon,
  repo: FolderGit2Icon,
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
  other: "Other",
};

function SkillSourceIcon(props: { kind: ProviderSkillSourceKind }) {
  const Icon = SKILL_SOURCE_ICON_BY_KIND[props.kind];
  return (
    <>
      <Icon aria-hidden="true" className="size-4 shrink-0 text-icon-muted" />
      <span className="sr-only">{SKILL_SOURCE_LABEL_BY_KIND[props.kind]} skill</span>
    </>
  );
}
