import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import type { ComposerPathSearchTarget } from "@t3tools/client-runtime/state/threads";
import { resolveProviderSkillSourceKind } from "@t3tools/client-runtime/providerSkills";
import {
  PROVIDER_DISPLAY_NAMES,
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
  ArrowDownIcon,
  ArrowUpIcon,
  BoxIcon,
  CornerDownLeftIcon,
  EraserIcon,
  MessageCircleQuestionIcon,
  MessagesSquareIcon,
  SearchXIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Children,
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Command, CommandGroup, CommandGroupLabel, CommandItem, CommandList } from "../ui/command";
import { Kbd } from "../ui/kbd";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";

export type ComposerCommandItem = {
  readonly metadata?: string | undefined;
  readonly environmentLabel?: string | undefined;
} & (
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
      updatedAt?: string | undefined;
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
);

export interface ComposerCommandGroup {
  readonly key: string;
  readonly label: string;
  readonly items: ComposerCommandItem[];
}

function providerLabel(provider: ProviderDriverKind): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? "Provider";
}

function composerCommandItemGroup(
  item: ComposerCommandItem,
  triggerKind: ComposerTriggerKind | null,
): { key: string; label: string } {
  switch (item.type) {
    case "slash-command":
      return { key: "t3code", label: "T3 Code" };
    case "provider-slash-command":
      return { key: `provider:${item.provider}`, label: providerLabel(item.provider) };
    case "skill": {
      if (triggerKind === "slash-command") return { key: "skills", label: "Skills" };
      // `$` groups skills by where they come from, which replaces the per-row source badge.
      const source = resolveProviderSkillSourceKind(item.skill);
      if (source === "personal") return { key: "skills:personal", label: "Personal" };
      if (source === "repo" || source === "project") {
        return { key: "skills:project", label: "Project" };
      }
      if (source === "app") return { key: "skills:app", label: "Plugins" };
      return { key: `skills:${item.provider}`, label: providerLabel(item.provider) };
    }
    case "path":
      return { key: "paths", label: "Files and folders" };
    case "pull-request":
      return { key: "pull-requests", label: "Pull requests" };
    case "thread":
      return { key: "threads", label: "Threads" };
    case "environment":
      return { key: "environments", label: "Machines" };
    case "model":
      return { key: "models", label: "Models" };
  }
}

export function groupComposerCommandItems(
  items: ReadonlyArray<ComposerCommandItem>,
  triggerKind: ComposerTriggerKind | null,
): ComposerCommandGroup[] {
  const groups = new Map<string, { key: string; label: string; items: ComposerCommandItem[] }>();
  for (const item of items) {
    const group = composerCommandItemGroup(item, triggerKind);
    const existing = groups.get(group.key);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(group.key, { ...group, items: [item] });
    }
  }
  const ordered = [...groups.values()];
  if (triggerKind === "path") {
    const order = ["threads", "environments", "paths"];
    ordered.sort((left, right) => order.indexOf(left.key) - order.indexOf(right.key));
  }
  return ordered;
}

const SLASH_COMMAND_ICONS: Record<ComposerSlashCommand, LucideIcon> = {
  model: BoxIcon,
  clear: EraserIcon,
  side: MessageCircleQuestionIcon,
  btw: MessageCircleQuestionIcon,
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
  const groups = groupComposerCommandItems(props.items, props.triggerKind);
  // `#` lists threads right away, but pull requests come from the git host and can take
  // seconds. Hold their group open with a loading row so they don't silently pop in later.
  const pullRequestsPending =
    props.isLoading &&
    props.triggerKind === "pull-request" &&
    !groups.some((group) => group.key === "pull-requests");

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
      <ComposerMenuSurface
        ref={listRef}
        data-composer-command-menu="true"
        // Keep focus in the editor so a click anywhere in the menu leaves it open.
        onMouseDown={(event) => {
          event.preventDefault();
        }}
      >
        {props.items.length > 0 ? (
          <CommandList
            id={props.listId}
            aria-label={props.triggerKind ? LISTBOX_LABEL_BY_TRIGGER[props.triggerKind] : undefined}
            className="max-h-112 min-h-0"
          >
            {pullRequestsPending ? (
              <CommandGroup>
                <CommandGroupLabel>Pull requests</CommandGroupLabel>
                <div
                  role="status"
                  className="flex min-h-8 items-center gap-2 px-2 text-meta text-dim-foreground"
                >
                  <Spinner aria-hidden className="size-[15px] shrink-0" />
                  <span className="min-w-0 truncate">Loading pull requests...</span>
                </div>
              </CommandGroup>
            ) : null}
            {groups.map((group) => (
              <CommandGroup key={group.key}>
                <CommandGroupLabel>{group.label}</CommandGroupLabel>
                {group.items.map((item) => (
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
            ))}
          </CommandList>
        ) : (
          // Nothing to list yet: the menu keeps its header and one row's height,
          // so searching and no-match read as states of the same list.
          <div className="p-2">
            {props.triggerKind ? (
              <div className="px-2 py-1.5 text-meta text-dim-foreground">
                {LISTBOX_LABEL_BY_TRIGGER[props.triggerKind]}
              </div>
            ) : null}
            <div
              role="status"
              data-composer-command-menu-empty={props.isLoading ? "loading" : "no-match"}
              className="flex min-h-8 items-center gap-2 px-2 text-meta text-dim-foreground"
            >
              {props.isLoading ? (
                <Spinner aria-hidden className="size-[15px] shrink-0" />
              ) : (
                <SearchXIcon aria-hidden className="size-[15px] shrink-0" />
              )}
              <span className="min-w-0 truncate">
                {props.isLoading
                  ? props.triggerKind === "skill" || props.triggerKind === "slash-command"
                    ? "Searching workspace skills..."
                    : props.triggerKind === "pull-request"
                      ? "Finding pull request..."
                      : "Searching workspace files..."
                  : (props.emptyStateText ??
                    (props.triggerKind === "skill"
                      ? "No skills found. Try / to browse provider commands."
                      : props.triggerKind === "path"
                        ? "No matching files or folders."
                        : "No matching command."))}
              </span>
            </div>
          </div>
        )}
        <ComposerMenuFooter
          hints={
            props.items.length > 0
              ? [
                  {
                    keys: [
                      <>
                        <ArrowUpIcon />
                        <ArrowDownIcon />
                      </>,
                    ],
                    label: "Navigate",
                  },
                  {
                    keys: [<CornerDownLeftIcon key="enter" />],
                    label: props.triggerKind === "slash-command" ? "Run" : "Insert",
                  },
                  { keys: ["esc"], label: "Close" },
                ]
              : [{ keys: ["esc"], label: "Close" }]
          }
        />
      </ComposerMenuSurface>
    </Command>
  );
});

/** The floating popover the composer's menus share: 520px wide, above the composer. */
function ComposerMenuSurface({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "surface-popover kbd-in-popover flex min-h-0 w-full flex-col overflow-hidden rounded-card text-popover-foreground [--kbd-background:var(--kbd-fill)]",
        className,
      )}
      {...props}
    />
  );
}

/** Key hints under a hairline, one per action the open menu takes from the keyboard. */
function ComposerMenuFooter(props: {
  hints: ReadonlyArray<{ keys: ReadonlyArray<ReactNode>; label: string }>;
}) {
  return (
    <div
      data-slot="composer-menu-footer"
      className="mx-1.5 mb-1.5 flex shrink-0 items-center gap-3 border-t border-divider px-2.5 pt-2 pb-1 font-normal text-caption text-dim-foreground pointer-coarse:hidden"
    >
      {props.hints.map((hint) => (
        <span key={hint.label} className="inline-flex items-center gap-1.25">
          <span className="inline-flex items-center gap-0.5">
            {Children.map(hint.keys, (key) => (
              <Kbd size="sm">{key}</Kbd>
            ))}
          </span>
          {hint.label}
        </span>
      ))}
    </div>
  );
}

function ComposerCommandItemIcon(props: {
  item: ComposerCommandItem;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
}) {
  const { item } = props;
  const iconClassName = cn(
    "size-[15px] shrink-0",
    props.isActive ? "text-foreground" : "text-muted-foreground",
  );
  switch (item.type) {
    case "path":
      return (
        <PierreEntryIcon
          pathValue={item.path}
          kind={item.pathKind}
          theme={props.resolvedTheme}
          className="size-[15px]"
        />
      );
    case "pull-request": {
      const presentation = resolvePullRequestState(item.pullRequest);
      return (
        <presentation.Icon
          role="img"
          aria-label={presentation.label}
          className={cn("size-[15px] shrink-0", presentation.toneClassName)}
        />
      );
    }
    case "thread":
      return <MessagesSquareIcon aria-hidden="true" className={iconClassName} />;
    case "environment":
      return (
        <EnvironmentMachineIcon kind={item.machine} aria-hidden="true" className={iconClassName} />
      );
    case "slash-command": {
      const Icon = SLASH_COMMAND_ICONS[item.command];
      return <Icon aria-hidden="true" className={iconClassName} />;
    }
    case "provider-slash-command":
      return <TerminalIcon aria-hidden="true" className={iconClassName} />;
    case "skill":
      return <BoxIcon aria-hidden="true" className={iconClassName} />;
    case "model":
      return (
        <ProviderInstanceIcon
          driverKind={item.driverKind}
          displayName={item.providerDisplayName}
          acpRegistryAgentId={item.acpRegistryAgentId}
          acpRegistryIconUrl={item.acpRegistryIconUrl}
          className="size-[15px] shrink-0"
          iconClassName="size-[15px]"
        />
      );
  }
}

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  optionId: string;
  item: ComposerCommandItem;
  triggerKind: ComposerTriggerKind | null;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const isSlashSkill =
    props.triggerKind === "slash-command" && props.item.type === "skill" ? props.item.skill : null;
  const pullRequestPresentation =
    props.item.type === "pull-request" ? resolvePullRequestState(props.item.pullRequest) : null;
  const descriptionRef = useRef<HTMLSpanElement>(null);
  const [descriptionTruncated, setDescriptionTruncated] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the rendered description so only cut-off text gets a tooltip
  useLayoutEffect(() => {
    const description = descriptionRef.current;
    setDescriptionTruncated(
      props.isActive && !!description && description.scrollWidth > description.clientWidth,
    );
  }, [props.isActive]);

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
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      <ComposerCommandItemIcon
        item={props.item}
        resolvedTheme={props.resolvedTheme}
        isActive={props.isActive}
      />
      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
        <span
          className={cn(
            "min-w-0 max-w-full truncate text-label",
            props.item.type === "pull-request" ||
              (props.triggerKind === "slash-command" && !isSlashSkill)
              ? "font-mono text-meta [--type-meta:0.78125rem]"
              : "font-sans",
          )}
        >
          {isSlashSkill ? (
            <>
              <span className="text-secondary-label">/skill:</span>
              {formatProviderSkillDisplayName(isSlashSkill)}
            </>
          ) : (
            props.item.label
          )}
        </span>
        <Tooltip open={descriptionTruncated}>
          <TooltipTrigger
            tabIndex={-1}
            render={
              <span
                ref={descriptionRef}
                className="min-w-0 flex-1 truncate text-left font-normal text-dim-foreground text-meta"
              />
            }
          >
            {props.item.description}
            {props.item.environmentLabel ? (
              <span className="block">{props.item.environmentLabel}</span>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup>{props.item.description}</TooltipPopup>
        </Tooltip>
      </span>

      {props.item.type === "thread" && props.item.updatedAt ? (
        <ComposerThreadAge updatedAt={props.item.updatedAt} />
      ) : props.item.metadata ? (
        <span className="shrink-0 text-meta text-dim-foreground">{props.item.metadata}</span>
      ) : null}
      {pullRequestPresentation ? (
        <Badge
          variant={
            props.item.type === "pull-request" &&
            props.item.pullRequest.state === "open" &&
            !props.item.pullRequest.isDraft
              ? "success"
              : "secondary"
          }
        >
          {pullRequestPresentation.label}
        </Badge>
      ) : props.isActive ? (
        <Kbd size="sm" aria-hidden="true">
          <CornerDownLeftIcon />
        </Kbd>
      ) : null}
    </CommandItem>
  );
});

function ComposerThreadAge({ updatedAt }: { updatedAt: string }) {
  const nowMinute = useNowMinute();
  return (
    <span className="shrink-0 text-meta text-dim-foreground">
      {formatRelativeTimeLabel(updatedAt, Date.parse(`${nowMinute}:00.000Z`))}
    </span>
  );
}

export function composerSuggestionOptionId(listId: string, itemId: string): string {
  // JSON escapes lone UTF-16 surrogates before URI encoding without losing identity.
  return `${listId}-${encodeURIComponent(JSON.stringify(itemId))}`;
}

const LISTBOX_LABEL_BY_TRIGGER: Record<ComposerTriggerKind, string> = {
  path: "Files and folders",
  "pull-request": "Pull requests and threads",
  "slash-command": "Commands",
  skill: "Skills",
};
