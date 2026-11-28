// Investigation aid; reads layout without asking the list to remeasure or repair it.
// Enable in production: localStorage.setItem("t3:timeline-gap-recorder", "1"), then reload.
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
// A blank stretch that heals before the delayed checks look is still recorded: the visible list is
// sampled every SAMPLE_MS and a stretch of FLASH_PX or more lasting FLASH_MS or more is reported.
const SAMPLE_MS = 50;
const FLASH_PX = 150;
const FLASH_MS = 100;

interface RowLayout {
  index: number;
  key: string;
  kind: string;
  lastTurn: boolean;
  storedTop: number;
  storedSize: number;
}

interface MeasuredRow extends RowLayout {
  domTop: number;
  domHeight: number;
  contentHeight: number | null;
}

interface MissingRow extends RowLayout {
  reason: "no slot mounted for a row in range";
  inBufferedRange: boolean;
  inViewport: boolean;
}

interface GapFinding {
  id: string;
  type: "hole" | "overlap" | "size-mismatch" | "empty-slot" | "missing-slot";
  px: number;
  top: number;
  rows: MeasuredRow[];
  missingRow?: MissingRow;
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
  startBuffered: number;
  endBuffered: number;
  viewportTop: number;
  viewportBottom: number;
  slots: { key: string | null; top: number; height: number; contentHeight: number | null }[];
  missingRows: MissingRow[];
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

function visibleList(monitor: Monitor) {
  const list = monitor.list();
  const viewport = list?.getScrollableNode();
  if (!list || !(viewport instanceof HTMLElement) || !viewport.checkVisibility()) return null;
  const content = viewport.firstElementChild;
  if (!(content instanceof HTMLElement)) return null;
  const sized =
    [...content.children].find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.style.position === "relative",
    ) ?? content;
  return { list, viewport, sized };
}

/** The tallest stretch of the viewport, between the first row's top and the last row's bottom, no mounted row covers. */
function largestBlankStretch(monitor: Monitor): number | null {
  const found = visibleList(monitor);
  if (!found) return null;
  const { list, viewport, sized } = found;
  const state = list.getState();
  const count = state.data.length;
  if (count === 0) return 0;
  const view = viewport.getBoundingClientRect();
  const zoom = viewport.offsetHeight ? view.height / viewport.offsetHeight : 1;
  const base = sized.getBoundingClientRect().top;
  const lastTop = state.positionAtIndex(count - 1);
  const lastSize = state.sizeAtIndex(count - 1);
  const rowsBottom =
    lastTop !== undefined && lastSize !== undefined ? lastTop + lastSize : sized.offsetHeight;
  const top = Math.max(view.top, base + (state.positionAtIndex(0) ?? 0) * zoom);
  const bottom = Math.min(view.bottom, base + rowsBottom * zoom);
  if (bottom - top < FLASH_PX * zoom) return 0;
  const covered: [number, number][] = [];
  for (const slot of sized.children) {
    if (!(slot instanceof HTMLElement) || slot.style.position !== "absolute") continue;
    const row = slot.querySelector<HTMLElement>("[data-timeline-row-id]")?.getBoundingClientRect();
    if (row && row.height > 0) covered.push([row.top, row.bottom]);
  }
  covered.sort((a, b) => a[0] - b[0]);
  let reached = top;
  let largest = 0;
  for (const [rowTop, rowBottom] of covered) {
    if (rowTop > reached) largest = Math.max(largest, Math.min(rowTop, bottom) - reached);
    reached = Math.max(reached, rowBottom);
    if (reached >= bottom) break;
  }
  return Math.max(largest, bottom - reached) / zoom;
}

function measure(monitor: Monitor): GapSnapshot | null {
  const found = visibleList(monitor);
  if (!found) return null;
  const { list, viewport, sized } = found;
  const state = list.getState();
  const zoom = viewport.offsetHeight
    ? viewport.getBoundingClientRect().height / viewport.offsetHeight
    : 1;
  const base = sized.getBoundingClientRect().top;
  const viewportTop = (viewport.getBoundingClientRect().top - base) / zoom;
  const viewportBottom = viewportTop + viewport.clientHeight;
  const slots: GapSnapshot["slots"] = [];
  const mounted = new Map<string, HTMLElement>();
  for (const child of sized.children) {
    if (!(child instanceof HTMLElement) || child.style.position !== "absolute") continue;
    const inner = child.querySelector<HTMLElement>("[data-timeline-row-id]");
    const key = inner?.dataset.timelineRowId ?? null;
    if (key !== null) mounted.set(key, child);
    slots.push({
      key,
      top: r1((child.getBoundingClientRect().top - base) / zoom),
      height: child.offsetHeight,
      contentHeight: inner?.offsetHeight ?? null,
    });
  }
  slots.sort((a, b) => a.top - b.top);
  const rows: MeasuredRow[] = [];
  const missingRows: MissingRow[] = [];
  for (let index = 0; index < state.data.length; index++) {
    const storedTop = state.positionAtIndex(index) ?? -1;
    const storedSize = state.sizeAtIndex(index) ?? -1;
    const bottom =
      storedSize >= 0
        ? storedTop + storedSize
        : (state.positionAtIndex(index + 1) ?? sized.offsetHeight);
    const inBufferedRange = index >= state.startBuffered && index <= state.endBuffered;
    const inViewport = storedTop >= 0 && bottom > viewportTop && storedTop < viewportBottom;
    if (!inBufferedRange && !inViewport) continue;
    const row: unknown = state.data[index];
    const layout: RowLayout = {
      index,
      key: String(field(row, "id") ?? index),
      kind: String(field(row, "kind") ?? "?"),
      lastTurn: monitor.latestRunId !== null && rowRunId(row) === monitor.latestRunId,
      storedTop: r1(storedTop),
      storedSize: r1(storedSize),
    };
    const slot = mounted.get(layout.key);
    if (!slot) {
      missingRows.push({
        ...layout,
        reason: "no slot mounted for a row in range",
        inBufferedRange,
        inViewport,
      });
      continue;
    }
    const inner = slot.querySelector<HTMLElement>("[data-timeline-row-id]");
    rows.push({
      ...layout,
      domTop: r1((slot.getBoundingClientRect().top - base) / zoom),
      domHeight: slot.offsetHeight,
      contentHeight: inner ? inner.offsetHeight : null,
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
    startBuffered: state.startBuffered,
    endBuffered: state.endBuffered,
    viewportTop: r1(viewportTop),
    viewportBottom: r1(viewportBottom),
    slots,
    missingRows,
    findings: [
      ...findTimelineGaps(rows),
      ...missingRows.map((row): GapFinding => ({
        id: `missing-slot:${row.key}`,
        type: "missing-slot",
        px: Math.max(0, row.storedSize),
        top: row.storedTop,
        rows: rows.filter((neighbor) => Math.abs(neighbor.index - row.index) <= 2),
        missingRow: row,
      })),
    ],
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
    rowKeys: new Set(
      lasting.flatMap((finding) => [
        ...finding.rows.map((row) => row.key),
        ...(finding.missingRow ? [finding.missingRow.key] : []),
      ]),
    ),
    trigger,
  };
  report(monitor, "appeared", trigger, { ...snapshot, findings: lasting });
  scheduleRecheck(monitor);
  announce(monitor);
}

function announce(monitor: Monitor) {
  if (toastedThreads.has(monitor.threadKey)) return;
  toastedThreads.add(monitor.threadKey);
  const id = toastManager.add({
    type: "warning",
    // oxlint-disable-next-line t3code/no-untranslated-copy -- Developer diagnostic, off in production unless enabled from the console.
    title: "timeline gap diagnostic recorded",
    timeout: 0,
    actionProps: {
      // oxlint-disable-next-line t3code/no-untranslated-copy -- Developer diagnostic, off in production unless enabled from the console.
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

/** Reports a blank stretch that lasts FLASH_MS, with the list's state when it appeared and what changed by the time it healed. */
function sampleBlankStretches(monitor: Monitor) {
  let blank: {
    startedAt: number;
    px: number;
    data: unknown;
    events: string[];
    snapshot: GapSnapshot;
  } | null = null;
  const interval = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    const now = performance.now();
    const px = largestBlankStretch(monitor);
    if (px !== null && px >= FLASH_PX) {
      if (blank) {
        blank.px = Math.max(blank.px, px);
        return;
      }
      const snapshot = measure(monitor);
      if (snapshot) {
        const data = monitor.list()?.getState().data;
        blank = { startedAt: now, px, data, events: [...monitor.events], snapshot };
      }
      return;
    }
    if (!blank) return;
    const { startedAt, px: largest, data, events, snapshot } = blank;
    blank = null;
    if (now - startedAt < FLASH_MS) return;
    const list = monitor.list();
    const state = px === null ? undefined : list?.getState();
    saveReport({
      at: new Date().toISOString(),
      phase: "blank stretch",
      threadKey: monitor.threadKey,
      durationMs: Math.round(now - startedAt),
      largestPx: r1(largest),
      events,
      eventsWhileBlank: monitor.events.filter((event) => !events.includes(event)),
      healedWith: state
        ? {
            dataChanged: state.data !== data,
            dataLength: state.data.length,
            scrollTop: r1(list?.getScrollableNode()?.scrollTop ?? -1),
            contentLength: r1(state.contentLength),
            startBuffered: state.startBuffered,
            endBuffered: state.endBuffered,
            isAtEnd: state.isAtEnd,
          }
        : "list hidden or gone",
      ...snapshot,
    });
    announce(monitor);
  }, SAMPLE_MS);
  return () => window.clearInterval(interval);
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this list with the gap recorder, samples it while visible and listens for the window becoming visible
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
    const stopSampling = sampleBlankStretches(monitor);
    return () => {
      stopSampling();
      document.removeEventListener("visibilitychange", onVisibility);
      cancel(monitor);
      monitors.delete(monitor);
    };
  }, [listRef, threadKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules the gap check after a turn status, fold or row count change
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
