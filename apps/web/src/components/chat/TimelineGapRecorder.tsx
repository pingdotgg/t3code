// Temporary investigation aid for the blank timeline gap (a row's slot taller or lower than
// its content). Dev builds only. Remove this file and its hook-ups once the cause is fixed.
// It only reads layout; it never calls into the list in a way that re-measures rows.
import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useRef } from "react";

import { toastManager } from "../ui/toast";

const STORAGE_KEY = "t3dev:timeline-gap-reports";
const MAX_REPORTS = 20;
const GAP_PX = 40;
const SIZE_PX = 16;
const FIRST_CHECK_MS = 1000;
const CONFIRM_CHECK_MS = 4000;
const OPEN_RECHECK_MS = 10_000;
const MAX_EVENTS = 8;

interface MeasuredRow {
  index: number;
  key: string;
  kind: string;
  lastTurn: boolean;
  domTop: number;
  domHeight: number;
  contentHeight: number | null;
  storedTop: number;
  storedSize: number;
}

interface GapFinding {
  id: string;
  type: "hole" | "overlap" | "size-mismatch" | "empty-slot";
  px: number;
  top: number;
  rows: MeasuredRow[];
}

interface GapSnapshot {
  paneWidth: number;
  devicePixelRatio: number;
  zoom: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  contentLength: number;
  dataLength: number;
  isFollowingEnd: boolean;
  isAtEnd: boolean;
  findings: GapFinding[];
  rows: MeasuredRow[];
}

interface Monitor {
  threadKey: string;
  latestRunId: string | null;
  list: () => LegendListRef | null;
  events: string[];
  open: { ids: Set<string>; rowKeys: Set<string>; trigger: string } | null;
  pending: { first: number; idle: number; second: number; recheck: number };
}

const monitors = new Set<Monitor>();
const toastedThreads = new Set<string>();
const r1 = (value: number) => Math.round(value * 10) / 10;

function readReports(): unknown[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveReport(report: object) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([...readReports(), report].slice(-MAX_REPORTS)),
    );
  } catch {
    // Storage can be full or blocked; the console still gets the report.
  }
  console.info("[t3dev] timeline gap report", report);
}

function copyReports() {
  return navigator.clipboard.writeText(JSON.stringify(readReports(), null, 2));
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function rowRunId(row: unknown): unknown {
  return (
    field(row, "runId") ??
    field(field(row, "message"), "runId") ??
    field(field(row, "entry"), "runId") ??
    field(field(row, "attempt"), "runId")
  );
}

// A finding's id names its rows' keys, so the confirming check can tell it is the same gap.
function findTimelineGaps(rows: readonly MeasuredRow[]): GapFinding[] {
  const sorted = rows.toSorted((a, b) => a.domTop - b.domTop);
  const findings: GapFinding[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const above = sorted[i - 1]!;
    const below = sorted[i]!;
    const space = below.domTop - (above.domTop + above.domHeight);
    if (Math.abs(space) > GAP_PX) {
      const type = space > 0 ? "hole" : "overlap";
      findings.push({
        id: `${type}:${above.key}:${below.key}`,
        type,
        px: r1(space),
        top: r1(above.domTop + above.domHeight),
        rows: sorted.slice(Math.max(0, i - 2), i + 2),
      });
    }
  }
  sorted.forEach((row, i) => {
    const neighbors = sorted.slice(Math.max(0, i - 1), i + 2);
    if (row.storedSize >= 0 && Math.abs(row.domHeight - row.storedSize) > SIZE_PX) {
      findings.push({
        id: `size-mismatch:${row.key}`,
        type: "size-mismatch",
        px: r1(row.domHeight - row.storedSize),
        top: row.domTop,
        rows: neighbors,
      });
    }
    if (row.contentHeight !== null && row.domHeight - row.contentHeight > GAP_PX) {
      findings.push({
        id: `empty-slot:${row.key}`,
        type: "empty-slot",
        px: r1(row.domHeight - row.contentHeight),
        top: r1(row.domTop + row.contentHeight),
        rows: neighbors,
      });
    }
  });
  return findings;
}

function measure(monitor: Monitor): GapSnapshot | null {
  const list = monitor.list();
  const viewport = list?.getScrollableNode();
  if (!list || !(viewport instanceof HTMLElement) || !viewport.checkVisibility()) return null;
  const state = list.getState();
  const content = viewport.firstElementChild;
  if (!content) return null;
  const sized =
    [...content.children].find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.style.position === "relative",
    ) ?? content;
  const zoom = viewport.offsetHeight
    ? viewport.getBoundingClientRect().height / viewport.offsetHeight
    : 1;
  const base = sized.getBoundingClientRect().top;
  const rows: MeasuredRow[] = [];
  const first = Math.max(0, state.startBuffered - 2);
  const last = Math.min(state.data.length - 1, state.endBuffered + 2);
  for (let index = first; index <= last; index++) {
    let slot = state.elementAtIndex(index);
    while (slot && slot.parentElement && slot.parentElement !== sized) slot = slot.parentElement;
    if (!(slot instanceof HTMLElement) || slot.parentElement !== sized) continue;
    const row: unknown = state.data[index];
    const inner = slot.querySelector<HTMLElement>("[data-timeline-row-id]");
    rows.push({
      index,
      key: String(field(row, "id") ?? index),
      kind: String(field(row, "kind") ?? "?"),
      lastTurn: monitor.latestRunId !== null && rowRunId(row) === monitor.latestRunId,
      domTop: r1((slot.getBoundingClientRect().top - base) / zoom),
      domHeight: slot.offsetHeight,
      contentHeight: inner ? inner.offsetHeight : null,
      storedTop: r1(state.positionAtIndex(index) ?? -1),
      storedSize: r1(state.sizeAtIndex(index) ?? -1),
    });
  }
  return {
    paneWidth: viewport.clientWidth,
    devicePixelRatio: window.devicePixelRatio,
    zoom: r1(zoom * 100) / 100,
    scrollTop: r1(viewport.scrollTop),
    scrollHeight: viewport.scrollHeight,
    clientHeight: viewport.clientHeight,
    contentLength: r1(state.contentLength),
    dataLength: state.data.length,
    isFollowingEnd: state.isFollowingEnd,
    isAtEnd: state.isAtEnd,
    findings: findTimelineGaps(rows),
    rows,
  };
}

function report(
  monitor: Monitor,
  phase: "appeared" | "disappeared",
  trigger: string,
  { rows, ...snapshot }: GapSnapshot,
) {
  const rowKeys = monitor.open?.rowKeys;
  saveReport({
    at: new Date().toISOString(),
    phase,
    threadKey: monitor.threadKey,
    trigger,
    events: [...monitor.events],
    ...snapshot,
    ...(phase === "disappeared" && rowKeys
      ? { rows: rows.filter((row) => rowKeys.has(row.key)) }
      : {}),
  });
}

function cancel(monitor: Monitor) {
  window.clearTimeout(monitor.pending.first);
  window.clearTimeout(monitor.pending.second);
  window.clearTimeout(monitor.pending.recheck);
  window.cancelIdleCallback?.(monitor.pending.idle);
}

function whenIdle(monitor: Monitor, run: () => void) {
  monitor.pending.idle = window.requestIdleCallback
    ? window.requestIdleCallback(run, { timeout: 2000 })
    : window.setTimeout(run, 0);
}

function confirm(monitor: Monitor, trigger: string, firstIds: Set<string>) {
  const snapshot = measure(monitor);
  if (!snapshot) return;
  const lasting = snapshot.findings.filter((finding) => firstIds.has(finding.id));
  if (lasting.length === 0) return;
  const known = monitor.open?.ids;
  if (known && lasting.every((finding) => known.has(finding.id))) return;
  monitor.open = {
    ids: new Set(lasting.map((finding) => finding.id)),
    rowKeys: new Set(lasting.flatMap((finding) => finding.rows.map((row) => row.key))),
    trigger,
  };
  report(monitor, "appeared", trigger, { ...snapshot, findings: lasting });
  scheduleRecheck(monitor);
  if (toastedThreads.has(monitor.threadKey)) return;
  toastedThreads.add(monitor.threadKey);
  const id = toastManager.add({
    type: "warning",
    title: "timeline gap recorded",
    timeout: 0,
    actionProps: {
      children: "copy report",
      onClick: () => {
        toastManager.close(id);
        void copyReports().catch(() => undefined);
      },
    },
  });
}

function check(monitor: Monitor, trigger: string) {
  const snapshot = measure(monitor);
  if (!snapshot) return;
  const ids = new Set(snapshot.findings.map((finding) => finding.id));
  if (monitor.open && ![...monitor.open.ids].some((id) => ids.has(id))) {
    report(monitor, "disappeared", trigger, snapshot);
    monitor.open = null;
  }
  if (ids.size === 0) return;
  monitor.pending.second = window.setTimeout(
    () => whenIdle(monitor, () => confirm(monitor, trigger, ids)),
    CONFIRM_CHECK_MS - FIRST_CHECK_MS,
  );
}

/** While a gap is open, look again now and then so its disappearance is caught too. */
function scheduleRecheck(monitor: Monitor) {
  window.clearTimeout(monitor.pending.recheck);
  monitor.pending.recheck = window.setTimeout(() => {
    if (!monitor.open) return;
    whenIdle(monitor, () => {
      check(monitor, "open gap recheck");
      if (monitor.open) scheduleRecheck(monitor);
    });
  }, OPEN_RECHECK_MS);
}

function trigger(monitor: Monitor, reason: string) {
  monitor.events = [...monitor.events, `${new Date().toISOString().slice(11, 19)} ${reason}`].slice(
    -MAX_EVENTS,
  );
  cancel(monitor);
  monitor.pending.first = window.setTimeout(
    () => whenIdle(monitor, () => check(monitor, reason)),
    FIRST_CHECK_MS,
  );
  if (monitor.open) scheduleRecheck(monitor);
}

/** Console helpers merged into `window.t3dev`. */
export const timelineGapDevApi = {
  gapReports: () => readReports(),
  copyGapReports: () => copyReports(),
  /** Measures every mounted list now and runs the usual two checks after it. */
  checkGapsNow: () =>
    [...monitors].map((monitor) => {
      trigger(monitor, "manual check");
      return { threadKey: monitor.threadKey, ...measure(monitor) };
    }),
};

export function TimelineGapRecorder(props: {
  listRef: React.RefObject<LegendListRef | null>;
  threadKey: string;
  dataLength: number;
  latestRunId: string | null;
  runStatus: string | null;
  foldCollapsing: boolean;
}) {
  const { listRef, threadKey, dataLength, latestRunId, runStatus, foldCollapsing } = props;
  const monitorRef = useRef<Monitor | null>(null);
  const seenRef = useRef<{
    dataLength: number;
    runStatus: string | null;
    foldCollapsing: boolean;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this list with the dev-only gap recorder and listens for the window becoming visible
  useEffect(() => {
    const monitor: Monitor = {
      threadKey,
      latestRunId: null,
      list: () => listRef.current,
      events: [],
      open: null,
      pending: { first: 0, idle: 0, second: 0, recheck: 0 },
    };
    monitorRef.current = monitor;
    seenRef.current = null;
    monitors.add(monitor);
    trigger(monitor, "thread shown");
    const onVisibility = () => {
      if (document.visibilityState === "visible") trigger(monitor, "window visible");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      cancel(monitor);
      monitors.delete(monitor);
    };
  }, [listRef, threadKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules the dev-only gap check after a turn status, fold or row count change
  useEffect(() => {
    const monitor = monitorRef.current;
    if (!monitor) return;
    monitor.latestRunId = latestRunId;
    const seen = seenRef.current;
    seenRef.current = { dataLength, runStatus, foldCollapsing };
    if (!seen) return;
    const changes: string[] = [];
    if (seen.runStatus !== runStatus)
      changes.push(`turn ${seen.runStatus ?? "none"} to ${runStatus ?? "none"}`);
    if (seen.foldCollapsing !== foldCollapsing)
      changes.push(foldCollapsing ? "fold collapsing" : "fold collapsed");
    if (seen.dataLength !== dataLength)
      changes.push(`data length ${seen.dataLength} to ${dataLength}`);
    if (changes.length > 0) trigger(monitor, changes.join(", "));
  }, [dataLength, foldCollapsing, latestRunId, runStatus]);

  return null;
}
