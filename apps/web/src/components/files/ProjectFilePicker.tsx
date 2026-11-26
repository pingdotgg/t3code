import { useAtomValue } from "@effect/atom-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState, type ReactNode } from "react";

import type { MessageResolver } from "~/i18n/messages";

import { useActiveProjectTarget, type ActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { useTheme } from "~/hooks/useTheme";
import { useRightPanelStore } from "~/rightPanelStore";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { type CommandPaletteActionItem } from "../CommandPalette.logic";
import { CommandPaletteResults } from "../CommandPaletteResults";
import {
  getProjectFilePickerMatches,
  groupMatchRanges,
  PROJECT_FILE_PICKER_RESULT_LIMIT,
} from "./ProjectFilePicker.logic";
import { useProjectFilePickerQuery } from "./projectFilesQueryState";

interface ProjectFilePickerProps {
  readonly setOpen: (open: boolean) => void;
}

function HighlightedFuzzyText(props: {
  readonly active: boolean;
  readonly indices: ReadonlyArray<number>;
  readonly value: string;
}) {
  if (!props.active) return props.value;

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of groupMatchRanges(props.indices)) {
    if (cursor < start) parts.push(props.value.slice(cursor, start));
    parts.push(
      <strong className="font-semibold text-foreground" key={start}>
        {props.value.slice(start, end)}
      </strong>,
    );
    cursor = end;
  }
  if (cursor < props.value.length) parts.push(props.value.slice(cursor));

  return <span className="text-muted-foreground">{parts}</span>;
}

function getEmptyStateMessage(
  query: string,
  error: string | null,
  isPending: boolean,
  resolve: MessageResolver,
): string {
  if (error) return error;
  const isSearching = query.trim().length > 0;
  if (isPending)
    return isSearching
      ? resolve(msg("Searching workspace files…"))
      : resolve(msg("Indexing workspace files…"));
  return isSearching ? resolve(msg("No matching files.")) : resolve(msg("No files found."));
}

function EmptyProjectFilePicker() {
  const gt = useGT();
  return (
    <CommandPaletteContent
      aria-label={gt("File picker")}
      escapeLabel={gt("Back", { $context: "button, leaves the file picker" })}
      footerActionLabel={gt("Open file")}
      inputProps={{ disabled: true, placeholder: gt("Search files…") }}
      mode="none"
      testId="project-file-picker"
      value=""
    >
      <div className="py-10 text-center text-sm text-muted-foreground">
        <T>Open a project to search its files.</T>
      </div>
    </CommandPaletteContent>
  );
}

function OpenProjectFilePicker(props: ProjectFilePickerProps & { target: ActiveProjectTarget }) {
  const { target } = props;
  const gt = useGT();
  const messages = useMessages();
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const result = useProjectFilePickerQuery(
    target.environmentId,
    target.cwd,
    query,
    PROJECT_FILE_PICKER_RESULT_LIMIT,
    undefined,
    messages,
  );
  const { resolvedTheme } = useTheme();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const matches = getProjectFilePickerMatches(result.entries, result.matchedQuery);
  const hasMatchedQuery = /\S/.test(result.matchedQuery);
  const items: CommandPaletteActionItem[] = matches.map((match) => ({
    kind: "action",
    value: `file:${match.path}`,
    searchTerms: [match.name, match.path],
    title: (
      <HighlightedFuzzyText
        active={hasMatchedQuery}
        value={match.name}
        indices={match.nameMatchIndices}
      />
    ),
    description: (
      <HighlightedFuzzyText
        active={hasMatchedQuery}
        value={match.path}
        indices={match.pathMatchIndices}
      />
    ),
    icon: <PierreEntryIcon pathValue={match.path} kind="file" theme={resolvedTheme} />,
    run: async () => {
      useRightPanelStore.getState().openFile(target.threadRef, match.path);
    },
  }));

  const emptyStateMessage = getEmptyStateMessage(query, result.error, result.isPending, messages);

  return (
    <CommandPaletteContent
      aria-label={gt("File picker")}
      autoHighlight="always"
      escapeLabel={gt("Back", { $context: "button, leaves the file picker" })}
      footerActionLabel={gt("Open file")}
      inputProps={{ placeholder: gt("Search files…") }}
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
        groups={
          items.length > 0 ? [{ value: "project-files", label: target.projectName, items }] : []
        }
        highlightedItemValue={highlightedItemValue}
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
    return <EmptyProjectFilePicker />;
  }

  return <OpenProjectFilePicker setOpen={props.setOpen} target={target} />;
}
