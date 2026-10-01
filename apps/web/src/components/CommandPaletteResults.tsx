import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { shortcutLabelForCommand } from "../keybindings";
import {
  getPaletteMatchSource,
  splitPaletteHighlightParts,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import {
  CommandCollection,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";
import { cn } from "~/lib/utils";
import { EnvironmentIdentity } from "./EnvironmentIdentity";

interface CommandPaletteResultsProps {
  emptyStateMessage?: string;
  groups: ReadonlyArray<CommandPaletteGroup>;
  highlightedItemValue?: string | null;
  isActionsOnly: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
  query?: string;
}

export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  if (props.groups.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        {props.emptyStateMessage ??
          (props.isActionsOnly
            ? "No matching actions."
            : "No matching commands, projects, or threads.")}
      </div>
    );
  }

  return (
    <CommandList>
      {props.groups.map((group) => (
        <CommandGroup items={group.items} key={group.value}>
          <CommandGroupLabel>{group.label}</CommandGroupLabel>
          <CommandCollection>
            {(item) => (
              <CommandPaletteResultRow
                item={item}
                key={item.value}
                keybindings={props.keybindings}
                isActive={props.highlightedItemValue === item.value}
                onExecuteItem={props.onExecuteItem}
                query={props.query ?? ""}
              />
            )}
          </CommandCollection>
        </CommandGroup>
      ))}
    </CommandList>
  );
}

function HighlightedPaletteText(props: { text: string; query: string }) {
  const trimmedQuery = props.query.trim();
  if (trimmedQuery.length === 0) {
    return <>{props.text}</>;
  }
  const parts = splitPaletteHighlightParts(props.text, trimmedQuery);
  return (
    <>
      {parts.map((part) =>
        part.highlighted ? (
          <mark key={part.start} className="rounded-[2px] bg-yellow-400/30 text-inherit">
            {part.text}
          </mark>
        ) : (
          <span key={part.start}>{part.text}</span>
        ),
      )}
    </>
  );
}

function CommandPaletteResultRow(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  isActive: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
  query: string;
}) {
  const shortcutLabel = props.item.shortcutCommand
    ? shortcutLabelForCommand(props.keybindings, props.item.shortcutCommand)
    : null;
  const matchSource =
    props.query.trim().length > 0 ? getPaletteMatchSource(props.item, props.query) : null;

  return (
    <CommandItem
      value={props.item.value}
      className={cn(
        "cursor-pointer gap-2 hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit data-selected:bg-transparent data-selected:text-inherit [&[data-highlighted][data-selected]]:bg-transparent [&[data-highlighted][data-selected]]:text-inherit",
        props.isActive && "bg-accent! text-accent-foreground!",
      )}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onExecuteItem(props.item);
      }}
    >
      {props.item.icon}
      {props.item.description ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {props.item.titleLeadingContent}
            <span className="truncate">
              {typeof props.item.title === "string" ? (
                <HighlightedPaletteText text={props.item.title} query={props.query} />
              ) : (
                props.item.title
              )}
            </span>
            {props.item.titleTrailingContent}
          </span>
          <span className="truncate text-muted-foreground/70 text-xs">
            {typeof props.item.description === "string" ? (
              <HighlightedPaletteText text={props.item.description} query={props.query} />
            ) : (
              props.item.description
            )}
          </span>
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
          {props.item.titleLeadingContent}
          <span className="truncate">
            {typeof props.item.title === "string" ? (
              <HighlightedPaletteText text={props.item.title} query={props.query} />
            ) : (
              props.item.title
            )}
          </span>
          {props.item.titleTrailingContent}
        </span>
      )}
      {matchSource ? (
        <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">
          {matchSource}
        </span>
      ) : null}
      {props.item.environmentId ? (
        <EnvironmentIdentity environmentId={props.item.environmentId} />
      ) : null}
      {props.item.timestamp ? (
        <span className="min-w-12 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/70">
          {props.item.timestamp}
        </span>
      ) : null}
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
      {props.item.kind === "submenu" ? (
        <ChevronRightIcon className="ml-auto size-4 shrink-0 text-muted-foreground/50" />
      ) : null}
    </CommandItem>
  );
}
