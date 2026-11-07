import { translateNow } from "~/components/media/translateNow";
import { useAtomValue } from "@effect/atom-react";
import { useState, type ReactNode } from "react";

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
  PROJECT_FILE_PICKER_RESULT_LIMIT,
} from "./ProjectFilePicker.logic";
import { useProjectFilePickerQuery } from "./projectFilesQueryState";

import { useT } from "~/hooks/useI18n";
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
  const t = translateNow;
  if (error) return error;
  const isSearching = query.trim().length > 0;
  if (isPending)
    return isSearching
      ? t("review.extra.searching.workspace.files")
      : t("review.extra.indexing.workspace.files");
  return isSearching ? t("review.extra.no.matching.files") : t("review.extra.no.files.found");
}

function EmptyProjectFilePicker() {
  const t = useT();
  return (
    <CommandPaletteContent
      aria-label={t("review.extra.file.picker")}
      escapeLabel={translateNow("review.files.back")}
      footerActionLabel={translateNow("review.files.openFile")}
      inputProps={{ disabled: true, placeholder: t("review.extra.search.files2") }}
      mode="none"
      testId="project-file-picker"
      value=""
    >
      <div className="py-10 text-center text-sm text-muted-foreground">
        {t("review.extra.open.a.project.to.search.its.files")}
      </div>
    </CommandPaletteContent>
  );
}

function OpenProjectFilePicker(props: ProjectFilePickerProps & { target: ActiveProjectTarget }) {
  const t = useT();
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

  const emptyStateMessage = getEmptyStateMessage(query, result.error, result.isPending);

  return (
    <CommandPaletteContent
      aria-label={t("review.extra.file.picker")}
      autoHighlight="always"
      escapeLabel={translateNow("review.files.back")}
      footerActionLabel={translateNow("review.files.openFile")}
      inputProps={{ placeholder: t("review.extra.search.files2") }}
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
