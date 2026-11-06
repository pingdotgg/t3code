import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectCodeCoverage,
  ProjectCodeEdge,
  ProjectCodeQuery,
  ProjectCodeQueryResult,
  ProjectCodeSymbol,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import { projectCode } from "~/state/projectCode";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { CodeIndexBadge } from "../files/CodeIndexBadge";
import {
  CoverageNote,
  EmptyNote,
  GRADE_LABEL,
  LocationRow,
  QueryState,
} from "../files/codeRelationshipRows";
import {
  NODE_CAP,
  NODE_HEIGHT,
  NODE_WIDTH,
  SIDE_LIMIT,
  buildExplorerModel,
  layoutExplorer,
  selectorFor,
  type ExplorerHops,
  type ExplorerModel,
  type ExplorerNode,
} from "./codeExplorerModel";

// Stroke patterns name the evidence grade without relying on colour.
const GRADE_DASH: Record<ProjectCodeEdge["evidenceGrade"], string | undefined> = {
  "compiler-indexed": undefined,
  "static-candidate": "6 4",
  "heuristic-candidate": "1.5 4",
};
const COVERAGE_RANK: Record<ProjectCodeCoverage["state"], number> = {
  complete: 0,
  partial: 1,
  stale: 2,
  unavailable: 3,
};
const PATH_CANDIDATES = 6;

interface Scope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly serverThreadId: ThreadId | null;
}

function codeQuery(scope: Scope, query: ProjectCodeQuery) {
  return projectCode.query({
    environmentId: scope.environmentId,
    input: {
      projectId: scope.projectId,
      ...(scope.serverThreadId ? { threadId: scope.serverThreadId } : {}),
      query,
    },
  });
}

/** Where a node opens: a caller at its call site, anything else at its declaration. */
function openLine(node: ExplorerNode): number {
  return node.side === "callers" && node.via?.source === node.symbol.id && node.via.line !== null
    ? node.via.line
    : node.symbol.startLine;
}

function nodeDetail(node: ExplorerNode): string {
  const hop = `${node.hop} ${node.hop === 1 ? "hop" : "hops"}`;
  if (node.via === null) return hop;
  const sites = node.via.sites > 1 ? ` · ${node.via.sites} call sites` : "";
  return `${hop} · ${GRADE_LABEL[node.via.grade]}${sites}`;
}

function worstCoverage(results: ReadonlyArray<ProjectCodeQueryResult>): ProjectCodeCoverage {
  return results.reduce((worst, result) =>
    COVERAGE_RANK[result.coverage.state] > COVERAGE_RANK[worst.coverage.state] ? result : worst,
  ).coverage;
}

function CallGraph(props: {
  readonly model: ExplorerModel;
  readonly onRecenter: (symbol: ProjectCodeSymbol) => void;
  readonly onOpen: (path: string, line: number) => void;
}) {
  const layout = layoutExplorer(props.model);
  return (
    <div className="max-h-[28rem] overflow-auto rounded-md border border-border/70 bg-muted/10">
      <div
        role="group"
        aria-label={`Call graph around ${props.model.focus.name}`}
        className="relative"
        style={{ width: layout.width, height: layout.height }}
      >
        <svg
          aria-hidden
          className="absolute inset-0 overflow-visible text-muted-foreground/70"
          width={layout.width}
          height={layout.height}
        >
          <defs>
            <marker
              id="code-explorer-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
            </marker>
          </defs>
          {layout.connectors.map(({ edge, path }) => (
            <path
              key={edge.key}
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth={edge.grade === "compiler-indexed" ? 1.75 : 1.25}
              strokeDasharray={GRADE_DASH[edge.grade]}
              markerEnd="url(#code-explorer-arrow)"
              data-grade={edge.grade}
            >
              <title>{`${edge.kind} · ${GRADE_LABEL[edge.grade]}`}</title>
            </path>
          ))}
        </svg>
        {layout.nodes.map(({ node, x, y }) => {
          const isFocus = node.side === "focus";
          const location = `${node.symbol.path}:${isFocus ? node.symbol.startLine : openLine(node)}`;
          return (
            <button
              key={node.symbol.id}
              type="button"
              aria-label={
                isFocus
                  ? `Open ${node.symbol.name} at ${location}`
                  : `Re-center on ${node.symbol.name}, ${node.side === "callers" ? "caller" : "callee"} ${nodeDetail(node)}`
              }
              onClick={() =>
                isFocus
                  ? props.onOpen(node.symbol.path, node.symbol.startLine)
                  : props.onRecenter(node.symbol)
              }
              className={cn(
                "absolute flex min-w-0 flex-col justify-center rounded-md border bg-background px-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                isFocus ? "border-primary ring-1 ring-primary/40" : "border-border",
              )}
              style={{ left: x, top: y, width: NODE_WIDTH, height: NODE_HEIGHT }}
            >
              <span className="truncate font-mono text-foreground">{node.symbol.name}</span>
              <span className="truncate text-2xs text-muted-foreground">{location}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SymbolList(props: {
  readonly label: string;
  readonly nodes: ReadonlyArray<ExplorerNode>;
  readonly empty: string;
  readonly onRecenter: (symbol: ProjectCodeSymbol) => void;
  readonly onOpen: (path: string, line: number) => void;
}) {
  return (
    <section aria-label={props.label} className="flex min-w-0 flex-col">
      <h3 className="px-2 text-2xs font-medium text-muted-foreground">
        {`${props.label} (${props.nodes.length})`}
      </h3>
      {props.nodes.length === 0 ? (
        <EmptyNote>{props.empty}</EmptyNote>
      ) : (
        <ol className="flex flex-col">
          {props.nodes.map((node) => {
            const line = openLine(node);
            return (
              <li key={node.symbol.id} className="flex min-w-0 items-center gap-1">
                <div className="min-w-0 flex-1">
                  <LocationRow
                    label={node.symbol.name}
                    location={`${node.symbol.path}:${line}`}
                    detail={nodeDetail(node)}
                    onOpen={() => props.onRecenter(node.symbol)}
                  />
                </div>
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={`Open ${node.symbol.name} at ${node.symbol.path}:${line}`}
                  onClick={() => props.onOpen(node.symbol.path, line)}
                >
                  <ExternalLinkIcon />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * "Does the focus reach that symbol?" over the whole index, not just what is drawn. The target
 * is searched on submit, not per keystroke, and a miss prints the bound it searched within.
 */
function PathQuery(
  props: Scope & {
    readonly focus: ProjectCodeSymbol;
    readonly onRecenter: (symbol: ProjectCodeSymbol) => void;
  },
) {
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [target, setTarget] = useState<ProjectCodeSymbol | null>(null);
  const [direction, setDirection] = useState<"from-focus" | "to-focus">("from-focus");
  const search = useEnvironmentQuery(
    submitted === null
      ? null
      : codeQuery(props, { operation: "search", text: submitted, limit: PATH_CANDIDATES }),
  );
  const [from, to] =
    target === null
      ? [null, null]
      : direction === "from-focus"
        ? [props.focus, target]
        : [target, props.focus];
  const path = useEnvironmentQuery(
    from === null || to === null
      ? null
      : codeQuery(props, { operation: "path", from: selectorFor(from), to: selectorFor(to) }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    setTarget(null);
    setSubmitted(trimmed.length === 0 ? null : trimmed.slice(0, 200));
  };
  const result = path.data;
  const searchResult = search.data;
  return (
    <section aria-label="Call path" className="flex flex-col gap-1 border-t border-border/60 pt-2">
      <div className="flex flex-wrap items-center gap-2 px-2">
        <h3 className="text-2xs font-medium text-muted-foreground">Call path</h3>
        <ToggleGroup
          aria-label="Path direction"
          value={[direction]}
          onValueChange={(next) => {
            if (next[0] === "from-focus" || next[0] === "to-focus") setDirection(next[0]);
          }}
        >
          <Toggle value="from-focus">{`${props.focus.name} reaches…`}</Toggle>
          <Toggle value="to-focus">{`…reaches ${props.focus.name}`}</Toggle>
        </ToggleGroup>
      </div>
      <form className="flex items-center gap-2 px-2" onSubmit={submit}>
        <Input
          size="compact"
          type="search"
          aria-label="Path target symbol"
          placeholder="Search a symbol, then press Enter"
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <Button type="submit" variant="outline" size="compact">
          Find
        </Button>
      </form>
      {submitted === null ? null : searchResult === null ? (
        <QueryState
          pending
          error={search.error}
          onRetry={search.refresh}
          pendingLabel="Searching symbols…"
        />
      ) : target === null ? (
        searchResult.matches.length === 0 ? (
          <EmptyNote>No indexed symbol matches that search.</EmptyNote>
        ) : (
          <ul aria-label="Path target candidates" className="flex flex-col">
            {searchResult.matches.map(({ symbol }) => (
              <li key={symbol.id}>
                <LocationRow
                  label={symbol.name}
                  location={`${symbol.path}:${symbol.startLine}`}
                  detail={symbol.kind}
                  onOpen={() => setTarget(symbol)}
                />
              </li>
            ))}
          </ul>
        )
      ) : result === null ? (
        <QueryState
          pending
          error={path.error}
          onRetry={path.refresh}
          pendingLabel="Walking calls…"
        />
      ) : (
        <PathResult result={result} from={from!} to={to!} onRecenter={props.onRecenter} />
      )}
    </section>
  );
}

function PathResult(props: {
  readonly result: ProjectCodeQueryResult;
  readonly from: ProjectCodeSymbol;
  readonly to: ProjectCodeSymbol;
  readonly onRecenter: (symbol: ProjectCodeSymbol) => void;
}) {
  const search = props.result.pathSearch;
  if (search === undefined) {
    return <EmptyNote>This server cannot answer path queries.</EmptyNote>;
  }
  if (search.unresolvedEndpoint !== null) {
    const name = search.unresolvedEndpoint === "from" ? props.from.name : props.to.name;
    return (
      <EmptyNote>
        {props.result.selection.state === "ambiguous"
          ? `Several declarations match ${name}; the index cannot tell which one you mean.`
          : `${name} is no longer in the index. Refresh after saving the file.`}
      </EmptyNote>
    );
  }
  if (!search.found) {
    return (
      <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
        {`No call path from ${props.from.name} to ${props.to.name} within ${search.maxDepth} hops (${search.visitedSymbols} symbols walked). That does not prove there is none.`}
        {search.walkTruncated
          ? " The walk stopped at its symbol budget before reaching that depth."
          : ""}
      </p>
    );
  }
  const nodes = new Map(props.result.nodes.map((node) => [node.id, node]));
  return (
    <ol
      aria-label={`Call path from ${props.from.name} to ${props.to.name}`}
      className="flex flex-col"
    >
      {props.result.nodes.slice(0, 1).map((node) => (
        <li key={node.id}>
          <LocationRow
            label={node.name}
            location={`${node.path}:${node.startLine}`}
            detail="start"
            onOpen={() => props.onRecenter(node)}
          />
        </li>
      ))}
      {props.result.edges.map((edge, index) => {
        const node = nodes.get(edge.target);
        if (node === undefined) return null;
        return (
          <li key={`${edge.source}:${edge.target}`}>
            <LocationRow
              label={node.name}
              location={`${node.path}:${node.startLine}`}
              detail={`hop ${index + 1} · ${edge.kind} · ${GRADE_LABEL[edge.evidenceGrade]}`}
              onOpen={() => props.onRecenter(node)}
            />
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The selected symbol in the middle, callers to its left and callees to its right, one or two
 * hops out. Built from the ordinary callers and callees queries on demand; the list below the
 * graph is its exact text equivalent and the keyboard path through it.
 */
export default function CodeExplorer(
  props: Scope & {
    readonly symbol: ProjectCodeSymbol;
    readonly onOpen: (path: string, line: number) => void;
  },
) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canQueryPath = config?.environment.capabilities.projectCodePath === true;
  const [history, setHistory] = useState<ReadonlyArray<ProjectCodeSymbol>>([props.symbol]);
  const [hops, setHops] = useState<ExplorerHops>(1);
  const current = history.at(-1) ?? props.symbol;
  const relation = (operation: "callers" | "callees", depth: ExplorerHops) =>
    codeQuery(props, { operation, symbol: selectorFor(current), depth, limit: SIDE_LIMIT });
  const callers = useEnvironmentQuery(relation("callers", 1));
  const callees = useEnvironmentQuery(relation("callees", 1));
  const callersFar = useEnvironmentQuery(hops === 2 ? relation("callers", 2) : null);
  const calleesFar = useEnvironmentQuery(hops === 2 ? relation("callees", 2) : null);
  const recenter = (symbol: ProjectCodeSymbol) => {
    if (symbol.id !== current.id) setHistory([...history, symbol]);
  };

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="ghost-muted"
        size="compact"
        disabled={history.length < 2}
        onClick={() => setHistory(history.slice(0, -1))}
      >
        <ArrowLeftIcon />
        Back
      </Button>
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-mono text-sm text-foreground">{current.name}</h3>
        <p className="truncate text-2xs text-muted-foreground">
          {`${current.kind} · ${current.path}:${current.startLine}`}
        </p>
      </div>
      <CodeIndexBadge
        environmentId={props.environmentId}
        projectId={props.projectId}
        threadId={props.serverThreadId ?? undefined}
      />
      <ToggleGroup
        aria-label="Hops shown"
        value={[String(hops)]}
        onValueChange={(next) => {
          if (next[0] === "1" || next[0] === "2") setHops(next[0] === "1" ? 1 : 2);
        }}
      >
        <Toggle value="1">1 hop</Toggle>
        <Toggle value="2">2 hops</Toggle>
      </ToggleGroup>
      <Button
        variant="outline"
        size="compact"
        onClick={() => props.onOpen(current.path, current.startLine)}
      >
        <ExternalLinkIcon />
        Open source
      </Button>
    </div>
  );

  const nearCallers = callers.data;
  const nearCallees = callees.data;
  if (nearCallers === null || nearCallees === null) {
    const failed = callers.error === null ? callees : callers;
    return (
      <div className="flex flex-col gap-2">
        {header}
        <QueryState
          pending
          error={failed.error}
          onRetry={() => {
            callers.refresh();
            callees.refresh();
          }}
        />
      </div>
    );
  }
  const selection = nearCallers.selection;
  if (selection.state === "ambiguous" || selection.state === "not-found") {
    return (
      <div className="flex flex-col gap-2">
        {header}
        <EmptyNote>
          {selection.state === "ambiguous"
            ? `${selection.candidates.length} symbols match this name here; the index cannot tell which one you mean.`
            : "This symbol is no longer in the index. Refresh after saving the file."}
        </EmptyNote>
      </div>
    );
  }
  // The index's own record of the focus is fresher than the one the explorer was opened with.
  const focus = selection.candidates[0] ?? current;
  const results = [nearCallers, nearCallees, callersFar.data, calleesFar.data].filter(
    (result): result is ProjectCodeQueryResult => result !== null,
  );
  const model = buildExplorerModel({
    focus,
    hops,
    callers: [nearCallers, ...(callersFar.data ? [callersFar.data] : [])],
    callees: [nearCallees, ...(calleesFar.data ? [calleesFar.data] : [])],
  });
  const coverage = worstCoverage(results);
  const farPending = hops === 2 && (callersFar.data === null || calleesFar.data === null);
  const farError = callersFar.error ?? calleesFar.error;
  const limited = model.omitted > 0 || results.some((result) => result.coverage.resultLimitReached);
  const drawn = model.callers.length + model.callees.length;

  return (
    <div className="flex flex-col gap-2">
      {header}
      <CoverageNote coverage={coverage} />
      {coverage.state === "stale" || coverage.state === "unavailable" ? (
        <p role="status" className="px-2 text-xs text-warning-foreground">
          {coverage.state === "stale"
            ? "The index is stale for some of these files. Verify calls in source before relying on them."
            : "The code index is not ready for this checkout, so no calls can be shown yet."}
        </p>
      ) : null}
      {farPending || farError !== null ? (
        <QueryState
          pending={farPending}
          error={farError}
          onRetry={() => {
            callersFar.refresh();
            calleesFar.refresh();
          }}
          pendingLabel="Reading the second hop…"
        />
      ) : null}
      {limited ? (
        <p role="status" className="px-2 text-2xs text-muted-foreground">
          {`Showing ${drawn} symbols. More were found than the explorer draws (${NODE_CAP} at most, ${SIDE_LIMIT} per side).`}
        </p>
      ) : null}
      {drawn === 0 ? (
        <EmptyNote>
          No static callers or callees found. Calls through values or dynamic dispatch are not
          tracked, so that does not prove nothing calls it.
        </EmptyNote>
      ) : (
        <CallGraph model={model} onRecenter={recenter} onOpen={props.onOpen} />
      )}
      <p className="px-2 text-2xs text-muted-foreground">
        Solid lines are compiler indexed, dashed lines static candidates, dotted lines heuristic.
      </p>
      <p className="px-2 text-2xs text-muted-foreground">
        Choose a symbol to center on it; the arrow opens it in the file preview.
      </p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <SymbolList
          label="Callers"
          nodes={model.callers}
          empty="No static callers found."
          onRecenter={recenter}
          onOpen={props.onOpen}
        />
        <SymbolList
          label="Callees"
          nodes={model.callees}
          empty="No static callees found."
          onRecenter={recenter}
          onOpen={props.onOpen}
        />
      </div>
      {canQueryPath ? (
        <PathQuery
          key={focus.id}
          environmentId={props.environmentId}
          projectId={props.projectId}
          serverThreadId={props.serverThreadId}
          focus={focus}
          onRecenter={recenter}
        />
      ) : (
        <EmptyNote>Update the server to use call paths.</EmptyNote>
      )}
    </div>
  );
}
