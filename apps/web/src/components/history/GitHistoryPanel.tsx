import { LegendList } from "@legendapp/list/react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, VcsHistoryCommit } from "@t3tools/contracts";
import { GitBranchIcon, TagIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "~/diffPanelStore";
import { GRAPH_CIRCLE_RADIUS, LANE_WIDTH, layoutGitGraph, rowGraph } from "~/lib/gitGraph";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const PAGE_SIZE = 200;
const ROW_HEIGHT = 44;

interface HistoryState {
  readonly commits: ReadonlyArray<VcsHistoryCommit>;
  readonly nextCursor: number | null;
  readonly loading: boolean;
  readonly error: string | null;
}

const INITIAL_STATE: HistoryState = { commits: [], nextCursor: null, loading: true, error: null };

export function GitHistoryPanel({ threadRef, cwd }: { threadRef: ScopedThreadRef; cwd: string }) {
  const readHistory = useAtomCommand(vcsEnvironment.readHistory, { reportFailure: false });
  const [state, setState] = useState(INITIAL_STATE);
  const [query, setQuery] = useState("");
  const requestId = useRef(0);
  const selectedSha = useDiffPanelStore((store) => {
    const selection = selectThreadDiffPanelSelection(store.byThreadKey, threadRef);
    return selection.kind === "commit" ? selection.sha : null;
  });

  // Callers mark the state loading first; the mount fetch starts from INITIAL_STATE.
  const fetchPage = useStableCallback((cursor: number) => {
    const id = ++requestId.current;
    void readHistory({
      environmentId: threadRef.environmentId,
      input: { cwd, cursor, limit: PAGE_SIZE },
    }).then((result) => {
      if (id !== requestId.current || isAtomCommandInterrupted(result)) return;
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Could not read the commit history.",
        }));
        return;
      }
      setState((current) => ({
        commits:
          cursor === 0 ? result.value.commits : [...current.commits, ...result.value.commits],
        nextCursor: result.value.nextCursor,
        loading: false,
        error: null,
      }));
    });
  });
  const load = (cursor: number) => {
    setState((current) => ({ ...current, loading: true, error: null }));
    fetchPage(cursor);
  };

  // The parent keys this panel by environment and checkout, so a mount is a new target.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the checkout's history from the server on mount
  useEffect(() => {
    fetchPage(0);
    return () => {
      requestId.current += 1;
    };
  }, [fetchPage]);

  const rows = layoutGitGraph(state.commits);
  const search = query.trim().toLocaleLowerCase();
  const items = state.commits.flatMap((commit, index) =>
    search &&
    ![commit.subject, commit.author, commit.sha, ...commit.refs.map((ref) => ref.name)].some(
      (value) => value.toLocaleLowerCase().includes(search),
    )
      ? []
      : [{ commit, row: rows[index]! }],
  );

  const openCommit = (sha: string) => {
    const panels = useRightPanelStore.getState();
    const diffOpen = selectActiveRightPanel(panels.byThreadKey, threadRef) === "diff";
    useDiffPanelStore.getState().selectCommit(threadRef, sha, !diffOpen);
    panels.open(threadRef, "diff");
  };

  const head = state.commits.find((commit) => commit.head);
  const branch = head?.refs.find((ref) => ref.kind === "local")?.name;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
        <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="max-w-[40%] shrink-0 truncate text-xs">
          {branch ?? head?.shortSha ?? "History"}
        </span>
        <div className="min-w-0 flex-1">
          <Input
            type="search"
            size="compact"
            aria-label="Search commits"
            placeholder="Search loaded commits"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh history"
          disabled={state.loading}
          onClick={() => load(0)}
        >
          <RefreshIcon refreshing={state.loading} />
        </Button>
      </div>
      {state.error ? (
        <p role="alert" className="border-b border-border/60 px-3 py-2 text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.commits.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-muted-foreground">
          {state.loading ? "Loading history…" : state.error ? null : "No commits yet"}
        </p>
      ) : items.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-muted-foreground">No matching commits</p>
      ) : (
        <LegendList
          data={items}
          keyExtractor={(item) => item.commit.sha}
          extraData={selectedSha}
          estimatedItemSize={ROW_HEIGHT}
          drawDistance={ROW_HEIGHT * 10}
          className="min-h-0 flex-1 overscroll-contain"
          onEndReached={() => {
            if (!search && !state.loading && state.nextCursor !== null) load(state.nextCursor);
          }}
          renderItem={({ item }) => (
            <HistoryRow
              commit={item.commit}
              row={item.row}
              filtered={search.length > 0}
              selected={item.commit.sha === selectedSha}
              onOpen={openCommit}
            />
          )}
        />
      )}
    </div>
  );
}

function HistoryRow({
  commit,
  row,
  filtered,
  selected,
  onOpen,
}: {
  commit: VcsHistoryCommit;
  row: ReturnType<typeof layoutGitGraph>[number];
  filtered: boolean;
  selected: boolean;
  onOpen: (sha: string) => void;
}) {
  const graph = rowGraph(row, ROW_HEIGHT);
  const date = new Date(commit.timestamp * 1000);
  const ref = commit.refs.find((candidate) => candidate.kind === "local") ?? commit.refs[0];
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onOpen(commit.sha)}
      style={{ height: ROW_HEIGHT }}
      className={cn(
        "flex w-full min-w-0 items-stretch pr-3 pl-1 text-left",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <svg
        aria-hidden
        className="shrink-0 overflow-visible"
        width={filtered ? LANE_WIDTH * 2 : graph.width}
        height={ROW_HEIGHT}
      >
        {filtered
          ? null
          : graph.paths.map((path) => (
              <path
                key={`${path.color}:${path.d}`}
                d={path.d}
                fill="none"
                stroke={path.color}
                strokeWidth={1}
                strokeLinecap="round"
              />
            ))}
        <circle
          cx={filtered ? LANE_WIDTH : graph.circle.cx}
          cy={graph.circle.cy}
          r={commit.head ? GRAPH_CIRCLE_RADIUS + 2 : GRAPH_CIRCLE_RADIUS}
          fill={commit.head ? "var(--background)" : graph.circle.color}
          stroke={graph.circle.color}
          strokeWidth={2}
        />
      </svg>
      <span className="ml-1 flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <span className="flex min-w-0 items-center gap-1">
          <span className={cn("min-w-0 flex-1 truncate text-xs", commit.head && "font-medium")}>
            {commit.subject || commit.shortSha}
          </span>
          {ref ? (
            <span className="flex max-w-28 shrink-0 items-center gap-0.5 rounded-full bg-muted px-1.5 text-2xs leading-4 text-muted-foreground">
              {ref.kind === "tag" ? (
                <TagIcon aria-hidden className="size-2.5 shrink-0" />
              ) : (
                <GitBranchIcon aria-hidden className="size-2.5 shrink-0" />
              )}
              <span className="truncate">{ref.name}</span>
            </span>
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{commit.author}</span>
          <time className="shrink-0" dateTime={date.toISOString()}>
            {formatRelativeTimeLabel(date.toISOString())}
          </time>
          <span className="shrink-0 font-mono">{commit.shortSha}</span>
        </span>
      </span>
    </button>
  );
}
