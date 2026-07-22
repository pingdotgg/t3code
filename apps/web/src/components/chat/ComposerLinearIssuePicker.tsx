import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, LinearIssueSummary, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { CircleDotIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { linearEnvironment } from "~/state/linear";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Command,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const LINEAR_SEARCH_DEBOUNCE_MS = 250;
const LINEAR_SEARCH_RESULT_LIMIT = 10;

interface ComposerLinearIssuePickerProps {
  environmentId: EnvironmentId;
  composerDraftTarget: ScopedThreadRef | DraftId;
  compact?: boolean;
}

export function ComposerLinearIssuePicker({
  environmentId,
  composerDraftTarget,
  compact,
}: ComposerLinearIssuePickerProps) {
  const statusResult = useAtomValue(linearEnvironment.status({ environmentId, input: {} }));
  const isConnected = AsyncResult.isSuccess(statusResult) && statusResult.value.connected;

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<ReadonlyArray<LinearIssueSummary>>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isAttaching, setIsAttaching] = useState(false);
  const [hasAttachError, setHasAttachError] = useState(false);

  const addLinearIssueContext = useComposerDraftStore((store) => store.addLinearIssueContext);
  const runSearchIssues = useAtomQueryRunner(linearEnvironment.searchIssues, {
    reportFailure: false,
  });
  const runGetIssue = useAtomQueryRunner(linearEnvironment.getIssue, { reportFailure: false });

  const searchRequestRef = useRef(0);
  const attachInFlightRef = useRef(false);
  const attachRequestRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const trimmed = search.trim();
    setIsSearching(true);
    setHasError(false);
    setHasAttachError(false);
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    const runQuery = () => {
      void runSearchIssues({
        environmentId,
        input: { query: trimmed, first: LINEAR_SEARCH_RESULT_LIMIT },
      }).then((result) => {
        if (searchRequestRef.current !== requestId) return;
        if (result._tag === "Success") {
          setResults(result.value.issues);
          setHasError(false);
        } else {
          setResults([]);
          setHasError(true);
        }
        setIsSearching(false);
      });
    };
    // Fetch recent issues immediately when opened with an empty query; debounce
    // only while the user is actively narrowing with typed text.
    if (trimmed.length === 0) {
      runQuery();
      return;
    }
    const timeout = window.setTimeout(runQuery, LINEAR_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [environmentId, open, runSearchIssues, search]);

  const handleSelect = useCallback(
    (issue: LinearIssueSummary) => {
      // Ignore concurrent selects while a detail fetch is already resolving.
      if (attachInFlightRef.current) return;
      attachInFlightRef.current = true;
      // Tag this fetch so a resolution that lands after the popover closed (or
      // after a reopen + newer select) is dropped instead of attaching silently.
      const requestId = attachRequestRef.current + 1;
      attachRequestRef.current = requestId;
      setIsAttaching(true);
      setHasAttachError(false);
      // Keep the popover open until getIssue resolves so a failed fetch doesn't
      // make the selection vanish with zero feedback.
      void runGetIssue({ environmentId, input: { issueId: issue.id } }).then((result) => {
        if (attachRequestRef.current !== requestId) return;
        attachInFlightRef.current = false;
        setIsAttaching(false);
        if (result._tag !== "Success") {
          setHasAttachError(true);
          return;
        }
        addLinearIssueContext(composerDraftTarget, result.value);
        setOpen(false);
        setSearch("");
        setResults([]);
      });
    },
    [addLinearIssueContext, composerDraftTarget, environmentId, runGetIssue],
  );

  if (!isConnected) return null;

  const trimmedSearch = search.trim();
  const emptyLabel = isSearching
    ? "Searching Linear…"
    : hasError
      ? "Couldn't load Linear issues"
      : trimmedSearch.length === 0
        ? "No recent issues."
        : "No issues found";
  const statusLine = isAttaching
    ? "Loading issue details…"
    : hasAttachError
      ? "Couldn't load issue details, try again"
      : null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSearch("");
          setResults([]);
          setHasAttachError(false);
          setIsAttaching(false);
          setIsSearching(false);
          attachInFlightRef.current = false;
          // Invalidate any in-flight detail fetch so it can't attach after close.
          attachRequestRef.current += 1;
          // Invalidate any in-flight search so a late resolution can't repopulate
          // results the next time the popover opens.
          searchRequestRef.current += 1;
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            aria-label="Attach Linear issue"
            className={cn(
              "shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80",
              compact ? "size-8 p-0" : "sm:px-2.5",
            )}
          />
        }
      >
        <CircleDotIcon aria-hidden="true" className="size-4" />
        {compact ? null : <span className="hidden text-xs sm:inline">Linear</span>}
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="w-80 max-w-none border-0 bg-transparent p-0 shadow-none before:hidden"
      >
        <Command mode="none" value={search} onValueChange={setSearch}>
          <div className="overflow-hidden rounded-[20px] border border-border/80 bg-popover/96 shadow-lg/8 backdrop-blur-xs">
            <CommandInput placeholder="Search Linear issues" />
            {results.length > 0 ? (
              <CommandList
                className={cn("max-h-72", isAttaching && "pointer-events-none opacity-60")}
                aria-busy={isAttaching}
              >
                <CommandGroup>
                  {trimmedSearch.length === 0 ? (
                    <CommandGroupLabel className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/55">
                      Recent
                    </CommandGroupLabel>
                  ) : null}
                  {results.map((issue) => (
                    <CommandItem
                      key={issue.id}
                      value={issue.id}
                      className="cursor-pointer select-none gap-2"
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => {
                        handleSelect(issue);
                      }}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="shrink-0 font-medium">{issue.identifier}</span>
                        <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                        <span className="shrink-0 text-muted-foreground/70 text-xs">
                          {issue.stateName}
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            ) : (
              <div className="px-5 py-3.5">
                <p className="text-muted-foreground/70 text-xs">{emptyLabel}</p>
              </div>
            )}
            {statusLine ? (
              <div className="border-border/60 border-t px-5 py-2.5">
                <p
                  className={cn(
                    "text-xs",
                    hasAttachError ? "text-destructive" : "text-muted-foreground/70",
                  )}
                >
                  {statusLine}
                </p>
              </div>
            ) : null}
          </div>
        </Command>
      </PopoverPopup>
    </Popover>
  );
}
