import {
  WS_METHODS,
  type EnvironmentId,
  type LoomAncestor,
  type LoomLane,
  type LoomLaneRelationship,
  type LoomMarker,
  type LoomRun,
  type LoomRunActivity,
  type LoomWindow,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { scopeThreadRef } from "../environment/scoped.ts";
import { createEnvironmentRpcQueryAtomFamily } from "../state/runtime.ts";

export function createProjectLoomAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    window: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-loom:window",
      tag: WS_METHODS.projectReadLoomWindow,
      staleTimeMs: 0,
    }),
  };
}

/** One visible lane row: a loaded lane, or an ancestor stub kept so its children nest. */
export interface LoomRow {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly relationship: LoomLaneRelationship;
  /** Kept on ancestor stubs too; this parent lives outside the local lane tree. */
  readonly delegatedFrom?: LoomLane["delegatedFrom"];
  readonly depth: number;
  /** Null for an ancestor that is not on this page and carries no activity. */
  readonly lane: LoomLane | null;
  readonly childCount: number;
  /** Rows a collapsed lane is hiding, counted through every level. */
  readonly hiddenCount: number;
  readonly collapsed: boolean;
  /** The lane names a parent this window could not load (deleted, or beyond the cap). */
  readonly parentMissing: boolean;
}

interface LoomNode {
  readonly identity: LoomLane | LoomAncestor;
  readonly lane: LoomLane | null;
  readonly children: Array<LoomNode>;
}

/**
 * Flattens lanes and ancestor stubs into rows in tree order: roots keep the order the server
 * returned (newest first), children follow their parent oldest first. A search keeps matching
 * rows plus the ancestry that places them, and expands collapsed rows on the way.
 */
export function buildLoomRows(
  window: Pick<LoomWindow, "lanes" | "ancestors">,
  collapsed: ReadonlySet<string>,
  search = "",
): ReadonlyArray<LoomRow> {
  const nodes = new Map<string, LoomNode>();
  for (const ancestor of window.ancestors) {
    nodes.set(ancestor.threadId, { identity: ancestor, lane: null, children: [] });
  }
  for (const lane of window.lanes) nodes.set(lane.threadId, { identity: lane, lane, children: [] });

  const roots: Array<LoomNode> = [];
  const seenRoots = new Set<LoomNode>();
  const rootOf = (node: LoomNode): LoomNode => {
    let current = node;
    const visited = new Set<LoomNode>();
    for (;;) {
      visited.add(current);
      const parentId = current.identity.parentThreadId;
      const parent = parentId === null ? undefined : nodes.get(parentId);
      if (parent === undefined || visited.has(parent)) return current;
      current = parent;
    }
  };
  for (const lane of window.lanes) {
    const root = rootOf(nodes.get(lane.threadId)!);
    if (!seenRoots.has(root)) {
      seenRoots.add(root);
      roots.push(root);
    }
  }
  for (const node of nodes.values()) {
    const parentId = node.identity.parentThreadId;
    const parent = parentId === null ? undefined : nodes.get(parentId);
    if (parent !== undefined && !seenRoots.has(node)) parent.children.push(node);
  }
  const createdAt = (node: LoomNode) => node.lane?.createdAt ?? "";
  for (const node of nodes.values()) {
    node.children.sort((left, right) => createdAt(left).localeCompare(createdAt(right)));
  }

  const needle = search.trim().toLowerCase();
  const matchesBelow = new Map<LoomNode, boolean>();
  const anyMatch = (node: LoomNode): boolean => {
    const known = matchesBelow.get(node);
    if (known !== undefined) return known;
    const result =
      node.identity.title.toLowerCase().includes(needle) || node.children.some(anyMatch);
    matchesBelow.set(node, result);
    return result;
  };
  const countBelow = (node: LoomNode): number =>
    node.children.reduce((total, child) => total + 1 + countBelow(child), 0);

  const rows: Array<LoomRow> = [];
  const visit = (node: LoomNode, depth: number) => {
    if (needle.length > 0 && !anyMatch(node)) return;
    const threadId = node.identity.threadId;
    const searchingBelow = needle.length > 0 && node.children.some(anyMatch);
    const isCollapsed = collapsed.has(threadId) && !searchingBelow && node.children.length > 0;
    const parentId = node.identity.parentThreadId;
    rows.push({
      threadId,
      title: node.identity.title,
      relationship: node.identity.relationship,
      ...(node.identity.delegatedFrom === undefined
        ? {}
        : { delegatedFrom: node.identity.delegatedFrom }),
      depth,
      lane: node.lane,
      childCount: node.children.length,
      hiddenCount: isCollapsed ? countBelow(node) : 0,
      collapsed: isCollapsed,
      parentMissing: depth === 0 && parentId !== null,
    });
    if (!isCollapsed) for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

export interface LoomLaneActivity {
  readonly runs: ReadonlyArray<LoomRun>;
  readonly markers: ReadonlyArray<LoomMarker>;
  readonly activity: ReadonlyArray<LoomRunActivity>;
}

/** Groups a window's runs, markers and activity by lane so each row reads only its own. */
export function groupLoomActivity(
  window: Pick<LoomWindow, "runs" | "markers" | "activity">,
): ReadonlyMap<string, LoomLaneActivity> {
  const byThread = new Map<
    string,
    { runs: Array<LoomRun>; markers: Array<LoomMarker>; activity: Array<LoomRunActivity> }
  >();
  const entry = (threadId: string) => {
    let value = byThread.get(threadId);
    if (value === undefined) {
      value = { runs: [], markers: [], activity: [] };
      byThread.set(threadId, value);
    }
    return value;
  };
  for (const run of window.runs) entry(run.threadId).runs.push(run);
  for (const marker of window.markers) entry(marker.threadId).markers.push(marker);
  for (const activity of window.activity) entry(activity.threadId).activity.push(activity);
  return byThread;
}

const MARKER_LABELS: Record<LoomMarker["kind"], string> = {
  checkpoint: "Checkpoint",
  pull_request: "Pull request linked",
  test_command: "Test command",
  subagent_task: "Agent task",
};

/** Remote tasks open their child there; native tasks and other markers open their local lane. */
export function loomMarkerThreadRef(
  environmentId: EnvironmentId,
  marker: LoomMarker,
): ScopedThreadRef {
  return marker.kind === "subagent_task" && marker.remoteChild !== undefined
    ? scopeThreadRef(marker.remoteChild.environmentId, marker.remoteChild.threadId)
    : scopeThreadRef(environmentId, marker.threadId);
}

export function loomMarkerLabel(marker: LoomMarker): string {
  switch (marker.kind) {
    case "checkpoint":
      return `${MARKER_LABELS.checkpoint}: ${marker.fileCount} ${marker.fileCount === 1 ? "file" : "files"} (+${marker.additions} -${marker.deletions})`;
    case "pull_request":
      return `${MARKER_LABELS.pull_request}: #${marker.number}${marker.title === null ? "" : ` ${marker.title}`}`;
    case "test_command":
      return `${MARKER_LABELS.test_command}${marker.exitCode === null ? "" : ` (exit ${marker.exitCode})`}: ${marker.command}`;
    case "subagent_task":
      return `${MARKER_LABELS.subagent_task}${marker.remoteChild === undefined ? "" : ` on ${marker.remoteChild.label}`}: ${marker.title ?? "untitled"} (${marker.status})`;
  }
}

/** Which limits cut this window short, in reading order, for a truncation note. */
export function loomTruncationNotes(window: Pick<LoomWindow, "truncated">): ReadonlyArray<string> {
  const { truncated } = window;
  return [
    truncated.lanes ? "more lanes on later pages" : null,
    truncated.ancestors ? "some parent lanes" : null,
    truncated.runs ? "older runs" : null,
    truncated.markers ? "older markers" : null,
    truncated.edges ? "older transfers" : null,
    truncated.activity ? "older tool activity" : null,
    truncated.bytes ? "older activity over the size limit" : null,
  ].filter((note): note is string => note !== null);
}

/** What the window's scans could not cover, for the same note as the truncation notes. */
export function loomCoverageNotes(window: Pick<LoomWindow, "coverage">): ReadonlyArray<string> {
  const { coverage } = window;
  const untimed = coverage.untimedTasksTruncated
    ? `more than ${coverage.untimedTasks} agent tasks`
    : `${coverage.untimedTasks} agent ${coverage.untimedTasks === 1 ? "task" : "tasks"}`;
  return [
    coverage.commandsTruncated
      ? `test commands from the newest ${coverage.commandsScanned} commands only`
      : null,
    coverage.untimedTasks > 0 ? `${untimed} with no recorded time, not shown` : null,
  ].filter((note): note is string => note !== null);
}
