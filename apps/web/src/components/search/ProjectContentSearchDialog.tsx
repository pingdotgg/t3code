import type { ProjectContentMatch } from "@t3tools/contracts";
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { useActiveProjectTarget, type ActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { useTheme } from "~/hooks/useTheme";
import { useI18n } from "~/i18n";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProjectContentSearch } from "~/state/queries";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HighlightedSearchLine } from "./HighlightedSearchLine";

interface ProjectContentSearchDialogProps {
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * Result rows are syntax highlighted, so mounting all 500 possible rows at
 * once stalls the UI. Rows render in windows that grow as the sentinel at the
 * bottom of the list scrolls into view (or keyboard navigation moves past
 * the rendered window).
 */
const VISIBLE_MATCH_WINDOW = 100;

interface MatchGroup {
  readonly path: string;
  readonly matches: ReadonlyArray<ProjectContentMatch & { readonly resultIndex: number }>;
}

function splitPath(path: string): { readonly name: string; readonly directory: string } {
  const separator = path.lastIndexOf("/");
  return separator === -1
    ? { name: path, directory: "" }
    : { name: path.slice(separator + 1), directory: path.slice(0, separator) };
}

function groupMatches(matches: ReadonlyArray<ProjectContentMatch>): MatchGroup[] {
  const groups = new Map<string, Array<ProjectContentMatch & { readonly resultIndex: number }>>();
  matches.forEach((match, resultIndex) => {
    const group = groups.get(match.path);
    const indexedMatch = { ...match, resultIndex };
    if (group) {
      group.push(indexedMatch);
    } else {
      groups.set(match.path, [indexedMatch]);
    }
  });
  return [...groups].map(([path, groupedMatches]) => ({ path, matches: groupedMatches }));
}

function SearchOptionButton(props: {
  readonly active: boolean;
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label={props.label}
            pressed={props.active}
            className="size-8 rounded-[5px] font-mono text-muted-foreground data-pressed:text-foreground sm:size-7"
            size="compact"
            variant="ghost"
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function EmptyContentSearchDialog() {
  const { t } = useI18n();
  return (
    <CommandPaletteContent
      aria-label={t("search.projectContents")}
      escapeLabel={t("common.back")}
      footerActionLabel={t("files.openFile")}
      inputProps={{ disabled: true, placeholder: t("search.projectContentsPlaceholder") }}
      mode="none"
      panelClassName="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground"
      testId="project-content-search"
      value=""
    >
      {t("files.openProjectToSearch")}
    </CommandPaletteContent>
  );
}

function OpenContentSearchDialog(props: {
  readonly onOpenChange: (open: boolean) => void;
  readonly target: ActiveProjectTarget;
}) {
  const { t } = useI18n();
  const { target } = props;
  const { resolvedTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const [visibleCount, setVisibleCount] = useState(VISIBLE_MATCH_WINDOW);

  const search = useProjectContentSearch({
    environmentId: target.environmentId,
    cwd: target.cwd,
    query,
    caseSensitive,
    wholeWord,
    useRegex,
  });
  const canOpenMatches = !search.isPending;
  const matches = search.matches;
  const visibleMatches = useMemo(() => matches.slice(0, visibleCount), [matches, visibleCount]);
  const groups = useMemo(() => groupMatches(visibleMatches), [visibleMatches]);

  useEffect(() => {
    setSelectedIndex(0);
    setVisibleCount(VISIBLE_MATCH_WINDOW);
  }, [matches]);

  useEffect(() => {
    if (selectedIndex >= visibleCount) {
      setVisibleCount(selectedIndex + VISIBLE_MATCH_WINDOW);
      return;
    }
    document
      .querySelector<HTMLElement>(`[data-content-search-result="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, visibleCount]);

  const observeLoadMoreSentinel = useCallback((sentinel: HTMLElement | null) => {
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleCount((current) => current + VISIBLE_MATCH_WINDOW);
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const openMatch = (match: ProjectContentMatch) => {
    if (!canOpenMatches) return;
    props.onOpenChange(false);
    useRightPanelStore.getState().openFile(target.threadRef, match.path, match.lineNumber);
  };
  const fileCount = useMemo(() => new Set(matches.map((match) => match.path)).size, [matches]);
  const showSearchStatus =
    search.hasQuery || search.isPending || search.error !== null || search.invalidRegex;

  return (
    <CommandPaletteContent
      aria-label={t("search.fileContentsInProject", { project: target.projectName })}
      escapeLabel={t("common.back")}
      footerActionLabel={t("files.openFile")}
      inputAccessory={
        <div className="absolute inset-e-2.5 top-1/2 flex shrink-0 -translate-y-1/2 items-center gap-0.5 rounded-md border bg-muted/30 p-0.5">
          <SearchOptionButton
            active={caseSensitive}
            label={t("search.matchCase")}
            onClick={() => setCaseSensitive((current) => !current)}
          >
            Aa
          </SearchOptionButton>
          <SearchOptionButton
            active={wholeWord}
            label={t("search.matchWholeWord")}
            onClick={() => setWholeWord((current) => !current)}
          >
            <span className="underline decoration-2 underline-offset-2">ab</span>
          </SearchOptionButton>
          <SearchOptionButton
            active={useRegex}
            label={t("search.useRegex")}
            onClick={() => setUseRegex((current) => !current)}
          >
            .*
          </SearchOptionButton>
        </div>
      }
      inputProps={{
        className: "pe-30",
        placeholder: t("search.inProject", { project: target.projectName }),
        onKeyDown: (event) => {
          if (event.key === "ArrowDown" && matches.length > 0) {
            event.preventDefault();
            setSelectedIndex((current) => (current + 1) % matches.length);
          } else if (event.key === "ArrowUp" && matches.length > 0) {
            event.preventDefault();
            setSelectedIndex((current) => (current - 1 + matches.length) % matches.length);
          } else if (event.key === "Enter") {
            // While a newer query is debouncing or in flight, the visible
            // matches belong to the previous query; opening one would jump
            // to a result the user did not ask for.
            if (!canOpenMatches) {
              event.preventDefault();
              return;
            }
            const match = matches[selectedIndex];
            if (match) {
              event.preventDefault();
              openMatch(match);
            }
          }
        },
      }}
      mode="none"
      onValueChange={setQuery}
      panelClassName="flex min-h-0 flex-1 flex-col"
      testId="project-content-search"
      value={query}
    >
      {showSearchStatus ? (
        <div className="flex h-9 shrink-0 items-center border-b px-3 text-xs text-muted-foreground">
          {search.isPending ? (
            <span className="flex items-center gap-2">
              <LoaderCircle className="size-3.5 animate-spin" /> {t("search.searching")}
            </span>
          ) : search.error ? (
            <span className="text-destructive">{search.error}</span>
          ) : search.invalidRegex ? (
            <span className="text-destructive">{t("search.invalidRegex")}</span>
          ) : (
            t("search.resultsSummary", {
              results: matches.length.toLocaleString(),
              suffix: search.truncated ? "+" : "",
              files: fileCount.toLocaleString(),
            })
          )}
        </div>
      ) : null}

      {matches.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {search.hasQuery && !search.isPending && !search.error
            ? t("search.noResults")
            : t("search.prompt")}
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1" scrollFade>
          <div className="py-2">
            {groups.map((group) => {
              const path = splitPath(group.path);
              return (
                <section className="pb-2" key={group.path}>
                  <div className="sticky top-0 z-10 flex h-8 items-center gap-2 bg-popover/95 px-3 text-xs backdrop-blur-sm">
                    <PierreEntryIcon
                      pathValue={group.path}
                      kind="file"
                      theme={resolvedTheme}
                      className="size-3.5"
                    />
                    <span className="font-medium text-foreground">{path.name}</span>
                    {path.directory ? (
                      <span className="min-w-0 truncate text-muted-foreground">
                        {path.directory}
                      </span>
                    ) : null}
                    <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 tabular-nums text-[10px] text-muted-foreground">
                      {group.matches.length}
                    </span>
                  </div>
                  {group.matches.map((match) => (
                    <button
                      type="button"
                      key={`${match.path}:${match.lineNumber}:${match.resultIndex}`}
                      data-content-search-result={match.resultIndex}
                      className={cn(
                        "flex h-7 w-full min-w-0 items-center gap-3 px-3 text-left font-mono text-xs hover:bg-accent/60 disabled:pointer-events-none",
                        match.resultIndex === selectedIndex && "bg-accent text-accent-foreground",
                      )}
                      disabled={!canOpenMatches}
                      onMouseEnter={() => setSelectedIndex(match.resultIndex)}
                      onClick={() => openMatch(match)}
                    >
                      <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground/70">
                        {match.lineNumber}
                      </span>
                      <span className="min-w-0 flex-1 truncate whitespace-pre">
                        <HighlightedSearchLine
                          match={match}
                          path={group.path}
                          theme={resolvedTheme}
                        />
                      </span>
                    </button>
                  ))}
                </section>
              );
            })}
            {matches.length > visibleCount ? (
              <div ref={observeLoadMoreSentinel} className="h-8" aria-hidden="true" />
            ) : null}
          </div>
        </ScrollArea>
      )}
    </CommandPaletteContent>
  );
}

export function ProjectContentSearchDialog(props: ProjectContentSearchDialogProps) {
  const target = useActiveProjectTarget();

  return target ? (
    <OpenContentSearchDialog
      // Reset the query and options whenever the workspace changes.
      key={`${target.environmentId}:${target.cwd}`}
      onOpenChange={props.onOpenChange}
      target={target}
    />
  ) : (
    <EmptyContentSearchDialog />
  );
}
