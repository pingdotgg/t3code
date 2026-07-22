import type { EnvironmentId, ProjectContentMatch } from "@t3tools/contracts";
import { LoaderCircle, Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { useProjectContentSearch } from "~/state/queries";

import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { HighlightedSearchLine } from "./project-search/HighlightedSearchLine";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";

interface ProjectContentSearchDialogProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenMatch: (relativePath: string, lineNumber: number) => void;
}

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
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.label}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-[5px] font-mono text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        props.active && "bg-accent text-foreground shadow-sm",
      )}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function ProjectContentSearchDialog(props: ProjectContentSearchDialogProps) {
  const { resolvedTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const search = useProjectContentSearch({
    environmentId: props.open ? props.environmentId : null,
    cwd: props.open ? props.cwd : null,
    query,
    caseSensitive,
    wholeWord,
    useRegex,
  });
  const matches = search.matches;
  const groups = useMemo(() => groupMatches(matches), [matches]);

  useEffect(() => {
    if (!props.open) setQuery("");
  }, [props.open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [matches]);

  useEffect(() => {
    document
      .querySelector<HTMLElement>(`[data-project-search-result="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const openMatch = (match: ProjectContentMatch) => {
    props.onOpenChange(false);
    props.onOpenMatch(match.path, match.lineNumber);
  };
  const fileCount = groups.length;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup
        className="h-[min(44rem,82vh)] max-w-3xl overflow-hidden"
        data-project-search
        showCloseButton={false}
        bottomStickOnMobile={false}
      >
        <DialogTitle className="sr-only">Search {props.projectName}</DialogTitle>
        <div className="flex shrink-0 items-center gap-2 border-b p-2">
          <Search className="ml-1 size-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            nativeInput
            unstyled
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && matches.length > 0) {
                event.preventDefault();
                setSelectedIndex((current) => (current + 1) % matches.length);
              } else if (event.key === "ArrowUp" && matches.length > 0) {
                event.preventDefault();
                setSelectedIndex((current) => (current - 1 + matches.length) % matches.length);
              } else if (event.key === "Enter") {
                const match = matches[selectedIndex];
                if (match) {
                  event.preventDefault();
                  openMatch(match);
                }
              }
            }}
            className="h-9 min-w-0 flex-1 px-2 font-mono text-sm"
            placeholder={`Search in ${props.projectName}`}
            aria-label={`Search file contents in ${props.projectName}`}
          />
          <div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md border bg-muted/30 p-0.5">
            <SearchOptionButton
              active={caseSensitive}
              label="Match case"
              onClick={() => setCaseSensitive((current) => !current)}
            >
              Aa
            </SearchOptionButton>
            <SearchOptionButton
              active={wholeWord}
              label="Match whole word"
              onClick={() => setWholeWord((current) => !current)}
            >
              <span className="underline decoration-2 underline-offset-2">ab</span>
            </SearchOptionButton>
            <SearchOptionButton
              active={useRegex}
              label="Use regular expression"
              onClick={() => setUseRegex((current) => !current)}
            >
              .*
            </SearchOptionButton>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center border-b px-3 text-xs text-muted-foreground">
            {search.isPending ? (
              <span className="flex items-center gap-2">
                <LoaderCircle className="size-3.5 animate-spin" /> Searching…
              </span>
            ) : search.error ? (
              <span className="text-destructive">{search.error}</span>
            ) : search.invalidRegex ? (
              <span className="text-destructive">Invalid regular expression</span>
            ) : !search.hasQuery ? (
              `Search every file in ${props.projectName}`
            ) : (
              `${matches.length.toLocaleString()}${search.truncated ? "+" : ""} results in ${fileCount.toLocaleString()} files`
            )}
          </div>

          {matches.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {search.hasQuery && !search.isPending && !search.error
                ? "No results found."
                : "Type to search across your project."}
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
                          data-project-search-result={match.resultIndex}
                          className={cn(
                            "flex h-7 w-full min-w-0 items-center gap-3 px-3 text-left font-mono text-xs hover:bg-accent/60",
                            match.resultIndex === selectedIndex &&
                              "bg-accent text-accent-foreground",
                          )}
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
              </div>
            </ScrollArea>
          )}
        </div>
        <div className="flex h-9 shrink-0 items-center gap-3 border-t px-3 text-[11px] text-muted-foreground">
          <span>↑↓ Navigate</span>
          <span>↵ Open file</span>
          <span>esc Close</span>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
