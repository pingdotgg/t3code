import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, type RefObject, useState } from "react";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { shortcutLabelForCommand } from "../keybindings";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteRow,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import {
  CommandCollection,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandListHeading,
  CommandListVirtualized,
  CommandShortcut,
} from "./ui/command";
import { getVirtualizedScrollFadeClassName } from "./ui/scroll-area";
import { ProjectPinButton } from "./ProjectPinButton";
import { SearchMatchHintLine, ThreadSearchMatchExcerpt } from "./ThreadSearchMatch";

type CommandPaletteResultItem = CommandPaletteActionItem | CommandPaletteSubmenuItem;

interface CommandPaletteResultsProps {
  emptyStateMessage?: string;
  groups: ReadonlyArray<CommandPaletteGroup>;
  highlightedItemValue?: string | null;
  isActionsOnly: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteResultItem) => void;
}

function CommandPaletteEmptyState(props: { emptyStateMessage?: string; isActionsOnly: boolean }) {
  return (
    <div className="py-10 text-center text-sm text-muted-foreground">
      {props.emptyStateMessage ??
        (props.isActionsOnly
          ? "No matching actions."
          : "No matching commands, projects, or threads.")}
    </div>
  );
}

export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  if (props.groups.length === 0) {
    return <CommandPaletteEmptyState {...props} />;
  }

  return (
    <CommandList>
      {props.groups.map((group) => (
        <CommandGroup items={group.items} key={group.value}>
          {group.label ? <CommandGroupLabel>{group.label}</CommandGroupLabel> : null}
          <CommandCollection>
            {(item) =>
              item.disabled ? (
                <DisabledCommandPaletteResultRow item={item} key={item.value} />
              ) : (
                <CommandPaletteResultRow
                  item={item}
                  key={item.value}
                  keybindings={props.keybindings}
                  isActive={props.highlightedItemValue === item.value}
                  onExecuteItem={props.onExecuteItem}
                />
              )
            }
          </CommandCollection>
        </CommandGroup>
      ))}
    </CommandList>
  );
}

export function scrollCommandPaletteRowIntoView(list: LegendListRef | null, rowIndex: number) {
  const element = list?.getState?.().elementAtIndex(rowIndex);
  if (element instanceof HTMLElement) {
    element.scrollIntoView({ block: "nearest" });
    return;
  }
  void list?.scrollIndexIntoView?.({ index: rowIndex, animated: false });
}

interface CommandPaletteVirtualizedResultsProps extends Omit<CommandPaletteResultsProps, "groups"> {
  rows: ReadonlyArray<CommandPaletteRow>;
  listRef: RefObject<LegendListRef | null>;
}

/** Pass flat items with virtualized to Command, scroll highlights via listRef, and handle Enter for
 * unmounted rows. */
export function CommandPaletteVirtualizedResults(props: CommandPaletteVirtualizedResultsProps) {
  const { listRef } = props;
  const [scrollFade, setScrollFade] = useState({ top: false, bottom: false });
  const updateScrollFade = () => {
    const scrollElement = listRef.current?.getScrollableNode?.();
    if (!(scrollElement instanceof HTMLElement)) return;
    const top = scrollElement.scrollTop > 1;
    const bottom =
      scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop > 1;
    setScrollFade((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  };

  if (props.rows.length === 0) {
    return <CommandPaletteEmptyState {...props} />;
  }

  return (
    <CommandListVirtualized>
      <LegendList<CommandPaletteRow>
        ref={listRef}
        data={props.rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.kind}
        extraData={props.highlightedItemValue}
        renderItem={({ item: row }) =>
          row.kind === "label" ? (
            <div className={row.first ? undefined : "pt-1.5"}>
              <CommandListHeading>{row.label}</CommandListHeading>
            </div>
          ) : row.itemIndex === null ? (
            <DisabledCommandPaletteResultRow item={row.item} />
          ) : (
            <CommandPaletteResultRow
              index={row.itemIndex}
              item={row.item}
              keybindings={props.keybindings}
              isActive={props.highlightedItemValue === row.item.value}
              onExecuteItem={props.onExecuteItem}
            />
          )
        }
        estimatedItemSize={34}
        drawDistance={400}
        onLayout={updateScrollFade}
        onScroll={updateScrollFade}
        contentContainerClassName="px-1.5"
        className={cn(
          "min-h-0 scroll-py-6 overflow-x-hidden overscroll-y-contain py-2 [&::-webkit-scrollbar-track]:my-2",
          getVirtualizedScrollFadeClassName(scrollFade),
        )}
      />
    </CommandListVirtualized>
  );
}

export function CommandPaletteTitleIcon(props: { children: ReactNode }) {
  return <span className="flex h-5 shrink-0 items-center [&_svg]:size-3.5">{props.children}</span>;
}

function CommandPaletteTitle({
  item,
}: {
  item: Pick<CommandPaletteActionItem | CommandPaletteSubmenuItem, "title">;
}) {
  const { title } = item;
  return (
    <span className="truncate" dir={typeof title === "string" ? textDirection(title) : undefined}>
      {title}
    </span>
  );
}

/**
 * Project and environment for a thread row whose second line shows a message
 * snippet or match hint instead, so similar rows can still be told apart.
 */
function ThreadRowContext({
  item,
}: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
}) {
  if (!item.threadSearch || !(item.threadContentMatch || item.matchHint)) return null;
  // A "Project: …" hint already names the project.
  const context = [item.threadSearch.projectTitle, item.threadSearch.environmentLabel]
    .filter((part) => part && part !== item.matchHint?.text)
    .join(" · ");
  return context ? (
    <span className="max-w-[45%] shrink-0 truncate text-dim-foreground text-caption">
      {context}
    </span>
  ) : null;
}

function DisabledCommandPaletteResultRow(props: { item: CommandPaletteResultItem }) {
  return (
    <div className="flex min-h-8 select-none items-center gap-2 rounded-control px-2 py-1.5 text-base opacity-64 sm:min-h-7 sm:text-sm">
      <CommandPaletteRowContent item={props.item} />
    </div>
  );
}

/** Icon, title (with optional description or thread match below it) and trailing title content. */
function CommandPaletteRowContent({ item }: { item: CommandPaletteResultItem }) {
  const title = (
    <>
      {item.titleLeadingContent}
      <CommandPaletteTitle item={item} />
    </>
  );
  return (
    <>
      <CommandPaletteTitleIcon>{item.icon}</CommandPaletteTitleIcon>
      {item.description || item.threadContentMatch || item.matchHint ? (
        <span
          className={cn(
            "flex min-w-0 flex-1",
            item.threadContentMatch || item.matchHint ? "flex-col" : "items-center gap-2",
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5 text-control text-foreground in-data-[active=true]:text-strong-foreground">
            {title}
            <ThreadRowContext item={item} />
          </span>
          {item.threadContentMatch ? (
            <ThreadSearchMatchExcerpt match={item.threadContentMatch} />
          ) : item.matchHint ? (
            <SearchMatchHintLine hint={item.matchHint} />
          ) : item.description ? (
            <span className="min-w-0 text-dim-foreground text-meta font-normal">
              {item.description}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-control text-foreground in-data-[active=true]:text-strong-foreground">
          {title}
        </span>
      )}
      {item.titleTrailingContent}
    </>
  );
}

function CommandPaletteResultRow(props: {
  index?: number;
  item: CommandPaletteResultItem;
  isActive: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteResultItem) => void;
}) {
  const shortcutLabel = props.item.shortcutCommand
    ? shortcutLabelForCommand(props.keybindings, props.item.shortcutCommand)
    : null;

  return (
    <CommandItem
      {...(props.index === undefined ? {} : { index: props.index })}
      value={props.item.value}
      active={props.isActive}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onExecuteItem(props.item);
      }}
    >
      <CommandPaletteRowContent item={props.item} />
      {props.item.kind === "action" && props.item.pin ? (
        <ProjectPinButton
          name={props.item.pin.name}
          pinned={props.item.pin.pinned}
          onToggle={props.item.pin.toggle}
          shortcutLabel={shortcutLabelForCommand(props.keybindings, "thread.pin")}
        />
      ) : null}
      {props.item.timestamp ? (
        <span className="min-w-12 shrink-0 text-right text-xs tabular-nums text-dim-foreground">
          {props.item.timestamp}
        </span>
      ) : null}
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
      {props.item.kind === "submenu" ? (
        <ChevronRightIcon className="-me-0.5 ms-auto size-3.5 shrink-0 text-dim-foreground" />
      ) : null}
    </CommandItem>
  );
}
