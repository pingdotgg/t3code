import { useAtomValue } from "@effect/atom-react";
import { FileSearchIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useActiveProjectTarget, type ActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { useTheme } from "~/hooks/useTheme";
import { shortcutLabelForCommand } from "~/keybindings";
import { useRightPanelStore } from "~/rightPanelStore";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { type CommandPaletteActionItem } from "../CommandPalette.logic";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { Kbd } from "../ui/kbd";
import {
  getProjectFilePickerMatches,
  PROJECT_FILE_PICKER_RESULT_LIMIT,
} from "./ProjectFilePicker.logic";
import { useProjectFilePickerQuery } from "./projectFilesQueryState";

interface ProjectFilePickerProps {
  readonly setOpen: (open: boolean) => void;
  /** What Esc does here: "Back" to the palette, or "Close". */
  readonly escapeLabel: string;
}

/** The picker's own shortcut at the end of its field, as it is bound right now. */
function FilePickerShortcutHint() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const label = shortcutLabelForCommand(keybindings, "filePicker.toggle");
  if (label === null) return null;
  return <Kbd>{label}</Kbd>;
}

// The shortcut takes the esc key's place at the field's end, on the same lines.
const FILE_PICKER_INPUT_PROPS = {
  placeholder: "Search files…",
  startAddon: <FileSearchIcon className="text-icon-muted" />,
  endAddon: <FilePickerShortcutHint />,
} as const;

function HighlightedFuzzyText(props: {
  readonly active: boolean;
  readonly indices: ReadonlyArray<number>;
  readonly value: string;
}) {
  if (!props.active) return props.value;

  const parts: ReactNode[] = [];
  let start = 0;
  for (const index of props.indices) {
    if (start < index) parts.push(props.value.slice(start, index));
    parts.push(
      <strong className="font-semibold text-foreground" key={index}>
        {props.value[index]}
      </strong>,
    );
    start = index + 1;
  }
  if (start < props.value.length) parts.push(props.value.slice(start));

  return <span className="text-muted-foreground">{parts}</span>;
}

function getEmptyStateMessage(query: string, error: string | null, isPending: boolean): string {
  if (error) return error;
  const isSearching = query.trim().length > 0;
  if (isPending) return isSearching ? "Searching workspace files…" : "Indexing workspace files…";
  return isSearching ? "No matching files." : "No files found.";
}

function EmptyProjectFilePicker(props: { readonly escapeLabel: string }) {
  return (
    <CommandPaletteContent
      aria-label="File picker"
      escapeLabel={props.escapeLabel}
      footerActionLabel="Open file"
      inputProps={{ ...FILE_PICKER_INPUT_PROPS, disabled: true }}
      mode="none"
      testId="project-file-picker"
      value=""
    >
      <div className="py-10 text-center text-body text-muted-foreground">
        Open a project to search its files.
      </div>
    </CommandPaletteContent>
  );
}

function OpenProjectFilePicker(props: ProjectFilePickerProps & { target: ActiveProjectTarget }) {
  const { target } = props;
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const result = useProjectFilePickerQuery(
    target.environmentId,
    target.cwd,
    query,
    PROJECT_FILE_PICKER_RESULT_LIMIT,
  );
  const { resolvedTheme } = useTheme();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const matches = getProjectFilePickerMatches(result.entries, result.matchedQuery);
  const hasMatchedQuery = /\S/.test(result.matchedQuery);
  const items: CommandPaletteActionItem[] = matches.map((match) => ({
    kind: "action",
    value: `file:${match.path}`,
    searchTerms: [match.name, match.path],
    // One line per file: the name, then its folder dimmed beside it (pen D2Qond).
    title: (
      <>
        <HighlightedFuzzyText
          active={hasMatchedQuery}
          value={match.name}
          indices={match.nameMatchIndices}
        />
        {match.path.includes("/") ? (
          <span className="ms-2 text-xs font-normal text-dim-foreground">
            <HighlightedFuzzyText
              active={hasMatchedQuery}
              value={match.path.slice(0, match.path.lastIndexOf("/"))}
              indices={match.pathMatchIndices.filter(
                (index) => index < match.path.lastIndexOf("/"),
              )}
            />
          </span>
        ) : null}
      </>
    ),
    // A 16px file icon in the palette's 14px icon column: centered on it, label on its line.
    icon: (
      <PierreEntryIcon
        className="-mx-px"
        pathValue={match.path}
        kind="file"
        theme={resolvedTheme}
      />
    ),
    run: async () => {
      useRightPanelStore.getState().openFile(target.threadRef, match.path);
    },
  }));

  const emptyStateMessage = getEmptyStateMessage(query, result.error, result.isPending);
  // `autoHighlight="always"` highlights the first row without reporting it, so
  // a stale or cleared value falls back to that row.
  const activeItemValue = items.some((item) => item.value === highlightedItemValue)
    ? highlightedItemValue
    : (items[0]?.value ?? null);

  return (
    <CommandPaletteContent
      aria-label="File picker"
      autoHighlight="always"
      escapeLabel={props.escapeLabel}
      footerActionLabel="Open file"
      inputProps={FILE_PICKER_INPUT_PROPS}
      mode="none"
      onItemHighlighted={(value) => {
        setHighlightedItemValue(typeof value === "string" ? value : null);
      }}
      onValueChange={(value) => {
        setHighlightedItemValue(null);
        setQuery(value);
      }}
      panelSize="tall-list"
      testId="project-file-picker"
      value={query}
    >
      <CommandPaletteResults
        groups={items.length > 0 ? [{ value: "project-files", label: "", items }] : []}
        highlightedItemValue={activeItemValue}
        isActionsOnly={false}
        keybindings={keybindings}
        onExecuteItem={(item) => {
          if (item.kind !== "action") return;
          props.setOpen(false);
          void item.run();
        }}
        emptyStateMessage={emptyStateMessage}
      />
    </CommandPaletteContent>
  );
}

export function ProjectFilePicker(props: ProjectFilePickerProps) {
  const target = useActiveProjectTarget();

  if (!target) {
    return <EmptyProjectFilePicker escapeLabel={props.escapeLabel} />;
  }

  return (
    <OpenProjectFilePicker
      setOpen={props.setOpen}
      escapeLabel={props.escapeLabel}
      target={target}
    />
  );
}
