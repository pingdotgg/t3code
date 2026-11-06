import { useAtomValue } from "@effect/atom-react";
import { isLikelyTestPath } from "@t3tools/shared/testPaths";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  CommandId,
  type EnvironmentId,
  type ProjectCodeEdge,
  type ProjectCodeQueryResult,
  type ProjectCodeSymbol,
  type ProjectFact,
  type ProjectId,
  type ProjectKnowledgeSearchInput,
  type ProjectKnowledgeSearchResult,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { NetworkIcon } from "lucide-react";
import { useState } from "react";

import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Button } from "~/components/ui/button";
import { randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useQuietThreadShell } from "~/state/entities";
import { projectCode } from "~/state/projectCode";
import { projectKnowledge } from "~/state/projectKnowledge";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useOpenCodeExplorer } from "../codeExplorer/openCodeExplorer";
import { CodeIndexBadge } from "./CodeIndexBadge";
import {
  CoverageNote,
  EmptyNote,
  GRADE_LABEL,
  GRADE_RANK,
  LocationRow,
  QueryState,
} from "./codeRelationshipRows";

// Each section is one bounded page; the panel is a pointer into source, not a graph browser.
const RESULT_LIMIT = 50;
// Project knowledge accepts at most 32 entity labels per search.
const MAX_ENTITIES = 32;

type RelationMode = "callers" | "callees" | "references" | "impact" | "tests";
type Tab = "symbols" | "decisions" | "history";

interface Location {
  readonly key: string;
  readonly label: string;
  readonly path: string;
  readonly line: number;
  readonly detail: string | null;
  readonly isTest: boolean;
}

/** Steps from `fromId` to `toId` along the result's edges, each edge pointing user → used. */
function hopsBetween(result: ProjectCodeQueryResult, fromId: string, toId: string): number | null {
  const next = new Map<string, string>();
  for (const edge of result.edges) if (!next.has(edge.source)) next.set(edge.source, edge.target);
  let current = fromId;
  for (let hops = 1; hops <= 8; hops += 1) {
    const target = next.get(current);
    if (target === undefined) return null;
    if (target === toId) return hops;
    current = target;
  }
  return null;
}

/**
 * Callers and references are one row per use site, at the use's line when the index has it;
 * callees are one row per declaration called. Impact is one row per affected file, likely
 * tests first. Tests are the test-file symbols a usage walk reached.
 */
function relationLocations(
  mode: RelationMode,
  result: ProjectCodeQueryResult,
  selectedId: string,
): ReadonlyArray<Location> {
  const nodes = new Map(result.nodes.map((node) => [node.id, node]));
  if (mode === "tests") {
    return (result.symbolGroups?.[0]?.tests ?? []).flatMap((id) => {
      const node = nodes.get(id);
      if (node === undefined) return [];
      const hops = hopsBetween(result, id, selectedId);
      return [
        {
          key: id,
          label: node.name,
          path: node.path,
          line: node.startLine,
          detail: hops === null ? "static" : `${hops} ${hops === 1 ? "hop" : "hops"} · static`,
          isTest: true,
        },
      ];
    });
  }
  if (mode === "impact") {
    const strongest = new Map<string, ProjectCodeEdge["evidenceGrade"]>();
    for (const edge of result.edges) {
      const path = nodes.get(edge.source)?.path;
      if (path === undefined) continue;
      const current = strongest.get(path);
      if (current === undefined || GRADE_RANK[edge.evidenceGrade] < GRADE_RANK[current]) {
        strongest.set(path, edge.evidenceGrade);
      }
    }
    const byFile = new Map<string, { line: number; count: number }>();
    for (const node of result.nodes) {
      if (node.id === selectedId) continue;
      const entry = byFile.get(node.path);
      if (entry === undefined) byFile.set(node.path, { line: node.startLine, count: 1 });
      else
        byFile.set(node.path, {
          line: Math.min(entry.line, node.startLine),
          count: entry.count + 1,
        });
    }
    return [...byFile]
      .map(([path, { line, count }]) => {
        const grade = strongest.get(path);
        return {
          key: path,
          label: path,
          path,
          line,
          detail: `${count} ${count === 1 ? "symbol" : "symbols"}${grade ? ` · ${GRADE_LABEL[grade]}` : ""}`,
          isTest: isLikelyTestPath(path),
        };
      })
      .toSorted((left, right) =>
        left.isTest === right.isTest ? left.path.localeCompare(right.path) : left.isTest ? -1 : 1,
      );
  }
  const seen = new Set<string>();
  const locations: Location[] = [];
  for (const edge of result.edges) {
    const otherId = mode === "callees" ? edge.target : edge.source;
    if (otherId === selectedId) continue;
    if (mode === "callees" && edge.source !== selectedId) continue;
    const other = nodes.get(otherId);
    if (other === undefined) continue;
    const line = mode === "callees" ? other.startLine : (edge.line ?? other.startLine);
    const key = `${other.id}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push({
      key,
      label: other.name,
      path: other.path,
      line,
      detail: GRADE_LABEL[edge.evidenceGrade],
      isTest: isLikelyTestPath(other.path),
    });
  }
  return locations;
}

const EMPTY_RELATION: Record<RelationMode, string> = {
  callers: "No static callers found. That does not prove nothing calls it.",
  callees: "No static callees found. Calls through values or dynamic dispatch are not tracked.",
  references: "No static references found. That does not prove it is unused.",
  impact: "No other files found in its static impact radius.",
  tests: "No test file reaches it within 3 static hops. That does not mean it is untested.",
};
const RELATION_MODES: ReadonlyArray<readonly [RelationMode, string]> = [
  ["callers", "Callers"],
  ["callees", "Callees"],
  ["references", "References"],
  ["impact", "Impact"],
  ["tests", "Tests"],
];

function RelationResults(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadRef: ScopedThreadRef;
  readonly symbol: ProjectCodeSymbol;
  readonly canQueryTests: boolean;
}) {
  const [mode, setMode] = useState<RelationMode>("callers");
  const symbol = {
    name: props.symbol.name,
    filePath: props.symbol.path,
    line: props.symbol.startLine,
  };
  const relation = useEnvironmentQuery(
    mode === "tests" && !props.canQueryTests
      ? null
      : projectCode.query({
          environmentId: props.environmentId,
          input: {
            projectId: props.projectId,
            threadId: props.threadRef.threadId,
            query: { operation: mode, symbol, limit: RESULT_LIMIT },
          },
        }),
  );
  const data = relation.data;
  const locations = data ? relationLocations(mode, data, props.symbol.id) : [];
  return (
    <div className="flex flex-col gap-1 border-t border-border/60 pt-1">
      <ToggleGroup
        aria-label={`Relationships of ${props.symbol.name}`}
        className="mx-2"
        value={[mode]}
        onValueChange={(next) => {
          const value = RELATION_MODES.find(([candidate]) => candidate === next[0]);
          if (value) setMode(value[0]);
        }}
      >
        {RELATION_MODES.map(([value, label]) => (
          <Toggle key={value} value={value}>
            {label}
          </Toggle>
        ))}
      </ToggleGroup>
      {mode === "tests" && !props.canQueryTests ? (
        <EmptyNote>Update the server to use tests.</EmptyNote>
      ) : data === null ? (
        <QueryState pending error={relation.error} onRetry={relation.refresh} />
      ) : data.selection.state === "ambiguous" ? (
        <EmptyNote>
          {`${data.selection.candidates.length} symbols match this name here; the index cannot tell which one you mean.`}
        </EmptyNote>
      ) : data.selection.state === "not-found" ? (
        <EmptyNote>This symbol is no longer in the index. Refresh after saving the file.</EmptyNote>
      ) : (
        <>
          <CoverageNote coverage={data.coverage} />
          {locations.length === 0 ? (
            <EmptyNote>{EMPTY_RELATION[mode]}</EmptyNote>
          ) : (
            locations.map((location) => (
              <LocationRow
                key={location.key}
                label={mode === "impact" ? (location.isTest ? "test" : "file") : location.label}
                location={mode === "impact" ? location.path : `${location.path}:${location.line}`}
                detail={location.detail}
                onOpen={() =>
                  useRightPanelStore
                    .getState()
                    .openFile(props.threadRef, location.path, location.line)
                }
              />
            ))
          )}
        </>
      )}
    </div>
  );
}

function outlineQuery(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  relativePath: string,
) {
  return projectCode.query({
    environmentId,
    input: {
      projectId,
      threadId,
      query: { operation: "symbols", filePath: relativePath, limit: RESULT_LIMIT },
    },
  });
}

function SymbolsTab(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadRef: ScopedThreadRef;
  readonly relativePath: string;
  readonly canQueryTests: boolean;
}) {
  const [selected, setSelected] = useState<ProjectCodeSymbol | null>(null);
  const openExplorer = useOpenCodeExplorer();
  const outline = useEnvironmentQuery(
    outlineQuery(
      props.environmentId,
      props.projectId,
      props.threadRef.threadId,
      props.relativePath,
    ),
  );
  const data = outline.data;
  if (data === null) return <QueryState pending error={outline.error} onRetry={outline.refresh} />;
  return (
    <>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <CoverageNote coverage={data.coverage} />
        </div>
        <Button
          variant="ghost-muted"
          size="micro"
          disabled={outline.isPending}
          onClick={outline.refresh}
        >
          Refresh
        </Button>
      </div>
      {data.coverage.state === "unavailable" ? null : data.nodes.length === 0 ? (
        <EmptyNote>
          No indexed declarations in this file. Its language may be unsupported, or it declares
          nothing the index recognizes.
        </EmptyNote>
      ) : (
        <div role="list" aria-label="Symbols in this file" className="flex flex-col">
          {data.nodes.map((node) => (
            <div role="listitem" key={node.id} className="flex min-w-0 items-center gap-1">
              <div className="min-w-0 flex-1">
                <LocationRow
                  label={node.name}
                  location={`${node.kind} · line ${node.startLine}`}
                  detail={node.isExported ? "exported" : null}
                  pressed={selected?.id === node.id}
                  onOpen={() => {
                    setSelected(selected?.id === node.id ? null : node);
                    useRightPanelStore
                      .getState()
                      .openFile(props.threadRef, props.relativePath, node.startLine);
                  }}
                />
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label={`Open ${node.name} in explorer`}
                      onClick={() =>
                        openExplorer({
                          environmentId: props.environmentId,
                          projectId: props.projectId,
                          threadRef: props.threadRef,
                          serverThreadId: props.threadRef.threadId,
                          symbol: node,
                        })
                      }
                    />
                  }
                >
                  <NetworkIcon />
                </TooltipTrigger>
                <TooltipPopup>Open in explorer</TooltipPopup>
              </Tooltip>
            </div>
          ))}
        </div>
      )}
      {selected !== null && data.nodes.some((node) => node.id === selected.id) ? (
        <RelationResults
          key={selected.id}
          environmentId={props.environmentId}
          projectId={props.projectId}
          threadRef={props.threadRef}
          symbol={selected}
          canQueryTests={props.canQueryTests}
        />
      ) : null}
    </>
  );
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Which of this file's names a fact's entities carry, path names first. */
function factMatch(
  fact: Extract<ProjectFact, { readonly content: string }>,
  pathNames: ReadonlySet<string>,
  symbolNames: ReadonlySet<string>,
): { readonly by: "path" | "name"; readonly label: string } | null {
  const entities = fact.entities.map((entity) => entity.toLowerCase());
  const path = entities.find((entity) => pathNames.has(entity));
  if (path !== undefined) return { by: "path", label: path };
  const name = fact.entities.find((entity) => symbolNames.has(entity.toLowerCase()));
  return name === undefined ? null : { by: "name", label: name };
}

/**
 * Facts whose entities name this file or one of its declarations. A declaration name is not
 * an identity: another `render` elsewhere in the project carries the same entity, so name
 * matches say so on every row.
 */
function DecisionsTab(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly relativePath: string;
  readonly canReadCode: boolean;
}) {
  const outline = useEnvironmentQuery(
    props.canReadCode
      ? outlineQuery(props.environmentId, props.projectId, props.threadId, props.relativePath)
      : null,
  );
  const outlineSettled = !props.canReadCode || outline.data !== null || outline.error !== null;
  const pathNames = new Set([
    props.relativePath.toLowerCase(),
    basename(props.relativePath).toLowerCase(),
  ]);
  const symbolNames = new Set(
    (outline.data?.nodes ?? [])
      .map((node) => node.name)
      .filter((name) => name.length >= 2)
      .map((name) => name.toLowerCase())
      .filter((name) => !pathNames.has(name)),
  );
  const entities = [...pathNames, ...symbolNames].slice(0, MAX_ENTITIES);
  if (!outlineSettled)
    return (
      <QueryState
        pending
        error={null}
        onRetry={outline.refresh}
        pendingLabel="Searching project knowledge…"
      />
    );
  return (
    <DecisionPages
      key={JSON.stringify([props.environmentId, props.projectId, props.relativePath, entities])}
      {...props}
      entities={entities}
      pathNames={pathNames}
      symbolNames={symbolNames}
    />
  );
}

type FactSearchPage = Extract<ProjectKnowledgeSearchResult["facts"], { state: "available" }>;

function DecisionPages(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly relativePath: string;
  readonly canReadCode: boolean;
  readonly entities: string[];
  readonly pathNames: ReadonlySet<string>;
  readonly symbolNames: ReadonlySet<string>;
}) {
  const [page, setPage] = useState(() => ({
    id: CommandId.make(randomUUID()),
    cursor: null as FactSearchPage["nextCursor"],
    previous: [] as FactSearchPage["matches"],
  }));
  const input: ProjectKnowledgeSearchInput = {
    projectId: props.projectId,
    // Entities filter the facts; the query only ranks them and must be two characters.
    query: basename(props.relativePath).padEnd(2, "_").slice(0, 200),
    requestId: page.id,
    ...(page.cursor ? { factCursor: page.cursor } : {}),
    entities: props.entities,
    entityMatch: "any",
    limit: 10,
    // Old servers ignore this additive option and still return a bounded page.
    messageLimit: 1,
    // Opening a file preview is not recall; it must not reinforce ranking.
    recordRetrieval: false,
  };
  const search = useEnvironmentQuery(
    projectKnowledge.search({ environmentId: props.environmentId, input }),
  );
  if (search.data === null && page.previous.length === 0) {
    return (
      <QueryState
        pending
        error={search.error}
        onRetry={search.refresh}
        pendingLabel="Searching project knowledge…"
      />
    );
  }
  const facts = search.data?.facts;
  if (facts?.state === "unavailable") {
    return <EmptyNote>Project knowledge search is unavailable on this server right now.</EmptyNote>;
  }
  const matches = [
    ...new Map(
      [...page.previous, ...(facts?.matches ?? [])].map((match) => [match.fact.id, match]),
    ).values(),
  ];
  const rows = matches.flatMap(({ fact }) => {
    if (fact.status === "forgotten") return [];
    const match = factMatch(fact, props.pathNames, props.symbolNames);
    return match === null ? [] : [{ fact, match }];
  });
  return (
    <div className="flex flex-col gap-1">
      <p className="px-2 text-2xs text-muted-foreground">
        Facts whose entities name this file
        {props.symbolNames.size > 0 ? " or one of its symbols" : ""}.
        {props.canReadCode ? "" : " Symbol names need file access, so only the path is matched."}
      </p>
      {rows.length === 0 ? (
        <EmptyNote>No project knowledge names this file or its symbols.</EmptyNote>
      ) : (
        <ul aria-label="Decisions for this file" className="flex flex-col gap-1">
          {rows.map(({ fact, match }) => (
            <li key={fact.id} className="flex flex-col gap-0.5 rounded-sm px-2 py-1 text-xs">
              <span className="flex items-baseline gap-2 text-2xs text-muted-foreground">
                <span className="font-medium text-foreground">{fact.kind}</span>
                <span className="min-w-0 flex-1 truncate">
                  {match.by === "path"
                    ? `matched by path ${match.label}`
                    : `matched by name ${match.label}`}
                </span>
              </span>
              <span className="line-clamp-3 text-foreground">{fact.content}</span>
              {match.by === "name" ? (
                <span className="text-2xs text-warning-foreground">
                  Name, not identity: a fact about another {match.label} elsewhere in the project
                  matches too.
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {search.data === null ? (
        <QueryState
          pending
          error={search.error}
          onRetry={search.refresh}
          pendingLabel="Searching project knowledge…"
        />
      ) : null}
      {facts?.nextCursor ? (
        <div className="px-2">
          <Button
            variant="ghost-muted"
            size="micro"
            disabled={search.isPending}
            onClick={() =>
              setPage({
                id: CommandId.make(randomUUID()),
                cursor: facts.nextCursor,
                previous: matches,
              })
            }
          >
            Show more
          </Button>
        </div>
      ) : null}
      {facts?.coverage === "partial" ? (
        <EmptyNote>Only the most relevant facts were ranked; some may be missing.</EmptyNote>
      ) : null}
    </div>
  );
}

/**
 * Threads whose turn checkpoints listed this file. A checkpoint records every change in its
 * workspace, including other people's, so rows say "present at checkpoint", never "authored".
 */
function PriorWorkTab(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly relativePath: string;
}) {
  const navigate = useNavigate();
  const history = useEnvironmentQuery(
    projectCode.fileHistory({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, path: props.relativePath, limit: 20 },
    }),
  );
  const data = history.data;
  if (data === null) {
    return (
      <QueryState
        pending
        error={history.error}
        onRetry={history.refresh}
        pendingLabel="Reading checkpoint history…"
      />
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="px-2 text-2xs text-muted-foreground">
        Present at checkpoint: the file changed in that thread's workspace during a turn, by the
        agent or anyone sharing the workspace.
      </p>
      {data.entries.length === 0 ? (
        <EmptyNote>No thread checkpoint in this project has listed this file.</EmptyNote>
      ) : (
        <div role="list" aria-label="Threads present at checkpoints" className="flex flex-col">
          {data.entries.map((entry) => (
            <div role="listitem" key={entry.threadId}>
              <LocationRow
                label={entry.title}
                location={`present at ${entry.checkpoints} ${entry.checkpoints === 1 ? "checkpoint" : "checkpoints"} · ${formatRelativeTimeLabel(entry.lastCheckpointAt)}`}
                detail={entry.archived ? "archived" : null}
                onOpen={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(
                      scopeThreadRef(props.environmentId, entry.threadId),
                    ),
                  })
                }
              />
            </div>
          ))}
        </div>
      )}
      {data.limitReached ? <EmptyNote>Showing the 20 most recent threads.</EmptyNote> : null}
      {data.index.state === "catching-up" ? (
        <div className="flex items-center gap-2 px-2 text-2xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            {`${data.index.pendingCheckpoints} older checkpoints are not indexed yet.`}
          </span>
          <Button variant="ghost-muted" size="micro" onClick={history.refresh}>
            Continue
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const TAB_LABEL: Record<Tab, string> = {
  symbols: "Symbols",
  decisions: "Decisions",
  history: "Prior work",
};

/**
 * On-demand code navigation for the open file. Nothing is queried until the section is
 * expanded, so indexing never delays the preview itself. Each tab is offered only when this
 * connection and server can answer it.
 */
export function FileCodeRelationships(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly relativePath: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canQueryCode = useAtomValue(projectCode.query.permissionAtom(props.environmentId));
  // File history and knowledge search both need thread read; history's guard carries it.
  const canReadThreads = useAtomValue(projectCode.fileHistory.permissionAtom(props.environmentId));
  const thread = useQuietThreadShell(props.threadRef);
  const [expanded, setExpanded] = useState(false);
  const [chosenTab, setChosenTab] = useState<Tab>("symbols");
  const capabilities = config?.environment.capabilities;
  const available: Record<Tab, boolean> = {
    symbols: capabilities?.projectCode === true && canQueryCode,
    decisions: capabilities?.projectKnowledge === true && canReadThreads,
    history: capabilities?.projectCode === true && canReadThreads,
  };
  const tabs = (Object.keys(TAB_LABEL) as Tab[]).filter((tab) => available[tab]);
  if (thread === null || tabs.length === 0) return null;
  const tab = available[chosenTab] ? chosenTab : tabs[0]!;
  return (
    <section aria-label="Code relationships" className="shrink-0 border-t border-border/60 px-1">
      <CollapsibleSectionHeader
        variant="panel"
        expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        accessory={
          expanded && available.symbols ? (
            <CodeIndexBadge
              environmentId={props.environmentId}
              projectId={thread.projectId}
              threadId={thread.id}
            />
          ) : null
        }
      >
        Code relationships
      </CollapsibleSectionHeader>
      {expanded ? (
        <ScrollArea className="max-h-72" scrollFade>
          <div className="flex flex-col gap-1 pb-2">
            {tabs.length > 1 ? (
              <ToggleGroup
                aria-label="Code relationship views"
                className="mx-2"
                value={[tab]}
                onValueChange={(next) => {
                  const value = tabs.find((candidate) => candidate === next[0]);
                  if (value) setChosenTab(value);
                }}
              >
                {tabs.map((value) => (
                  <Toggle key={value} value={value}>
                    {TAB_LABEL[value]}
                  </Toggle>
                ))}
              </ToggleGroup>
            ) : null}
            {tab === "symbols" ? (
              <SymbolsTab
                environmentId={props.environmentId}
                projectId={thread.projectId}
                threadRef={props.threadRef}
                relativePath={props.relativePath}
                canQueryTests={capabilities?.projectCodeTests === true}
              />
            ) : tab === "decisions" ? (
              <DecisionsTab
                environmentId={props.environmentId}
                projectId={thread.projectId}
                threadId={thread.id}
                relativePath={props.relativePath}
                canReadCode={available.symbols}
              />
            ) : capabilities?.projectCodeFileHistory !== true ? (
              <EmptyNote>Update the server to use prior work.</EmptyNote>
            ) : (
              <PriorWorkTab
                environmentId={props.environmentId}
                projectId={thread.projectId}
                relativePath={props.relativePath}
              />
            )}
          </div>
        </ScrollArea>
      ) : null}
    </section>
  );
}
