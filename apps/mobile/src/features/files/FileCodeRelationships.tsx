import { useAtomValue } from "@effect/atom-react";
import { isLikelyTestPath } from "@t3tools/shared/testPaths";
import {
  type EnvironmentId,
  type ProjectCodeCoverage,
  type ProjectCodeQueryResult,
  type ProjectCodeSymbol,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { projectCode } from "../../state/projectCode";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

// One bounded page per list; the section points into source rather than browsing a graph.
const RESULT_LIMIT = 30;

type Mode = "callers" | "impact";

interface Row {
  readonly key: string;
  readonly label: string;
  readonly location: string;
  readonly path: string;
  readonly line: number;
}

const GRADE_LABEL = {
  "compiler-indexed": "compiler indexed",
  "static-candidate": "static candidate",
  "heuristic-candidate": "heuristic",
} as const;

// Only languages seen in this checkout; `languages` is the analyzer's catalog.
function indexedLanguagesSuffix(coverage: ProjectCodeCoverage): string {
  return coverage.indexedLanguages?.length ? ` (${coverage.indexedLanguages.join(", ")})` : "";
}

function coverageLine(coverage: ProjectCodeCoverage): string {
  switch (coverage.state) {
    case "complete":
      return `Static candidates · ${coverage.filesIndexed} files indexed${indexedLanguagesSuffix(coverage)}`;
    case "partial":
      return `Static candidates · ${coverage.filesIndexed} of ${coverage.filesListed} files indexed${indexedLanguagesSuffix(coverage)}`;
    case "stale":
      return "Stale · some files changed since indexing. Verify in source.";
    case "unavailable":
      return "The code index is not ready for this checkout.";
  }
}

/** Callers are one row per use site; impact is one row per affected file, tests first. */
function relationRows(mode: Mode, result: ProjectCodeQueryResult, selectedId: string): Row[] {
  const nodes = new Map(result.nodes.map((node) => [node.id, node]));
  if (mode === "impact") {
    const byFile = new Map<string, number>();
    for (const node of result.nodes) {
      if (node.id === selectedId) continue;
      byFile.set(node.path, Math.min(byFile.get(node.path) ?? node.startLine, node.startLine));
    }
    return [...byFile]
      .sort(([left], [right]) => {
        const leftTest = isLikelyTestPath(left);
        return leftTest === isLikelyTestPath(right) ? left.localeCompare(right) : leftTest ? -1 : 1;
      })
      .map(([path, line]) => ({
        key: path,
        label: isLikelyTestPath(path) ? "test" : "file",
        location: path,
        path,
        line,
      }));
  }
  const seen = new Set<string>();
  return result.edges.flatMap((edge) => {
    const source = nodes.get(edge.source);
    if (edge.source === selectedId || source === undefined) return [];
    const line = edge.line ?? source.startLine;
    const key = `${source.id}:${line}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        key,
        label: source.name,
        location: `${source.path}:${line} · ${GRADE_LABEL[edge.evidenceGrade]}`,
        path: source.path,
        line,
      },
    ];
  });
}

function RowButton(props: {
  readonly label: string;
  readonly detail: string;
  readonly selected?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${props.detail}`}
      accessibilityState={props.selected === undefined ? undefined : { selected: props.selected }}
      onPress={props.onPress}
      className={cn("rounded-lg px-3 py-2 active:opacity-70", props.selected && "bg-subtle")}
    >
      <AppText className="font-mono text-sm" numberOfLines={1}>
        {props.label}
      </AppText>
      <AppText className="text-xs text-foreground-muted" numberOfLines={1}>
        {props.detail}
      </AppText>
    </Pressable>
  );
}

function Note(props: { readonly children: string }) {
  return <AppText className="px-3 py-1 text-xs text-foreground-muted">{props.children}</AppText>;
}

function Relations(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly symbol: ProjectCodeSymbol;
  readonly onOpenLocation: (path: string, line: number) => void;
}) {
  const [mode, setMode] = useState<Mode>("callers");
  const relation = useEnvironmentQuery(
    projectCode.query({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        threadId: props.threadId,
        query: {
          operation: mode,
          symbol: {
            name: props.symbol.name,
            filePath: props.symbol.path,
            line: props.symbol.startLine,
          },
          limit: RESULT_LIMIT,
        },
      },
    }),
  );
  const data = relation.data;
  const rows = data ? relationRows(mode, data, props.symbol.id) : [];
  return (
    <View className="gap-1 border-t border-border pt-1">
      <View className="flex-row gap-2 px-3" accessibilityRole="tablist">
        {(["callers", "impact"] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === value }}
            onPress={() => setMode(value)}
            className={cn("rounded-full px-3 py-1", mode === value && "bg-subtle-strong")}
          >
            <AppText className="text-xs">{value === "callers" ? "Callers" : "Impact"}</AppText>
          </Pressable>
        ))}
      </View>
      {data === null ? (
        <Note>{relation.error ?? "Indexing… the first query on a checkout can take a while."}</Note>
      ) : data.selection.state === "ambiguous" ? (
        <Note>Several symbols share this name here; the index cannot tell which one.</Note>
      ) : data.selection.state === "not-found" ? (
        <Note>This symbol is no longer in the index.</Note>
      ) : rows.length === 0 ? (
        <Note>
          {mode === "callers"
            ? "No static callers found. That does not prove nothing calls it."
            : "No other files found in its static impact radius."}
        </Note>
      ) : (
        rows.map((row) => (
          <RowButton
            key={row.key}
            label={row.label}
            detail={row.location}
            onPress={() => props.onOpenLocation(row.path, row.line)}
          />
        ))
      )}
    </View>
  );
}

function Body(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly relativePath: string;
  readonly onOpenLocation: (path: string, line: number) => void;
}) {
  const [selected, setSelected] = useState<ProjectCodeSymbol | null>(null);
  const outline = useEnvironmentQuery(
    projectCode.query({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        threadId: props.threadId,
        query: { operation: "symbols", filePath: props.relativePath, limit: RESULT_LIMIT },
      },
    }),
  );
  const data = outline.data;
  if (data === null) {
    return (
      <Note>{outline.error ?? "Indexing… the first query on a checkout can take a while."}</Note>
    );
  }
  return (
    <ScrollView className="max-h-80" nestedScrollEnabled>
      <Note>{coverageLine(data.coverage)}</Note>
      {data.coverage.state === "unavailable" ? null : data.nodes.length === 0 ? (
        <Note>No indexed declarations in this file. Its language may be unsupported.</Note>
      ) : (
        data.nodes.map((node) => (
          <RowButton
            key={node.id}
            label={node.name}
            detail={`${node.kind} · line ${node.startLine}`}
            selected={selected?.id === node.id}
            onPress={() => setSelected(selected?.id === node.id ? null : node)}
          />
        ))
      )}
      {selected !== null && data.nodes.some((node) => node.id === selected.id) ? (
        <Relations
          key={selected.id}
          environmentId={props.environmentId}
          projectId={props.projectId}
          threadId={props.threadId}
          symbol={selected}
          onOpenLocation={props.onOpenLocation}
        />
      ) : null}
    </ScrollView>
  );
}

/**
 * Symbols declared in the open file and where they are used. Collapsed until tapped, so the
 * file opens without waiting on the code index.
 */
export function FileCodeRelationships(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly relativePath: string;
  readonly onOpenLocation: (path: string, line: number) => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canQuery = useAtomValue(projectCode.query.permissionAtom(props.environmentId));
  const [expanded, setExpanded] = useState(false);
  if (config?.environment.capabilities.projectCode !== true || !canQuery) return null;
  return (
    <View className="border-t border-border bg-sheet pb-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="flex-row items-center justify-between px-4 py-3 active:opacity-70"
      >
        <AppText className="text-sm font-t3-medium">Code relationships</AppText>
        <AppText className="text-xs text-foreground-muted">{expanded ? "Hide" : "Show"}</AppText>
      </Pressable>
      {expanded ? (
        <Body
          environmentId={props.environmentId}
          projectId={props.projectId}
          threadId={props.threadId}
          relativePath={props.relativePath}
          onOpenLocation={props.onOpenLocation}
        />
      ) : null}
    </View>
  );
}
