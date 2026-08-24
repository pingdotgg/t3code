import { useAtomValue } from "@effect/atom-react";
import { useMemo, useState, type ReactNode } from "react";

import { useActiveProjectTarget, type ActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { useTheme } from "~/hooks/useTheme";
import { useI18n, type Translate } from "~/i18n";
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

function getEmptyStateMessage(
  query: string,
  error: string | null,
  isPending: boolean,
  t: Translate,
): string {
  if (error) return error;
  const isSearching = query.trim().length > 0;
  if (isPending) {
    return isSearching ? t("files.searchingWorkspace") : t("files.indexingWorkspace");
  }
  return isSearching ? t("files.noMatching") : t("files.noneFound");
}

function EmptyProjectFilePicker() {
  const { t } = useI18n();
  return (
    <CommandPaletteContent
      aria-label={t("files.picker")}
      escapeLabel={t("common.back")}
      footerActionLabel={t("files.openFile")}
      inputProps={{ disabled: true, placeholder: t("files.searchFilesPlaceholder") }}
      mode="none"
      testId="project-file-picker"
      value=""
    >
      <div className="py-10 text-center text-sm text-muted-foreground">
        {t("files.openProjectToSearch")}
      </div>
    </CommandPaletteContent>
  );
}

function OpenProjectFilePicker(props: ProjectFilePickerProps & { target: ActiveProjectTarget }) {
  const { t } = useI18n();
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
  const matches = useMemo(
    () => getProjectFilePickerMatches(result.entries, result.matchedQuery),
    [result.entries, result.matchedQuery],
  );
  const hasMatchedQuery = /\S/.test(result.matchedQuery);
  const items = useMemo<CommandPaletteActionItem[]>(
    () =>
      matches.map((match) => ({
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
      })),
    [hasMatchedQuery, matches, resolvedTheme, target.threadRef],
  );

  const emptyStateMessage = getEmptyStateMessage(query, result.error, result.isPending, t);

  return (
    <CommandPaletteContent
      aria-label={t("files.picker")}
      autoHighlight="always"
      escapeLabel={t("common.back")}
      footerActionLabel={t("files.openFile")}
      inputProps={{ placeholder: t("files.searchFilesPlaceholder") }}
      mode="none"
      onItemHighlighted={(value) => {
        setHighlightedItemValue(typeof value === "string" ? value : null);
      }}
      onValueChange={(value) => {
        setHighlightedItemValue(null);
        setQuery(value);
      }}
      panelClassName="max-h-[min(34rem,76vh)]"
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
