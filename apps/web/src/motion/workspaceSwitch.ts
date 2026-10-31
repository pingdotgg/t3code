/** Move one vertical workspace stack on the compositor. Keep row offsets relative to its starting
 * workspace so mounting rows cannot shift others. */
import { useSyncExternalStore } from "react";

import {
  selectFocusedWorkspace,
  selectLayoutPaneSlots,
  type LayoutPaneSlot,
  type LayoutState,
  type LayoutWorkspace,
} from "../layout/layoutModel";
import { getLayoutBehavior } from "../layout/layoutBehavior";
import { setLayoutFocusAnticipation, useLayoutStore } from "../layout/layoutStore";
import { isMacPlatform } from "../lib/utils";
import { MotionAnimation, playMotion, type MotionRun } from "./animation";
import {
  isDiscreteWheel,
  rubberBandClamp,
  rubberBandClampDerivative,
  SwipeTracker,
  WheelTail,
  wheelDeltaPx,
  WHEEL_STREAM_IDLE_MS,
  WORKSPACE_RUBBER_BAND,
} from "./gesture";
import { resolveMotion } from "./registry";
import { moveStripCamera, settleStripCamera } from "./stripCamera";

export interface WorkspaceStackRow {
  readonly id: string;
  /** Rows from the workspace the stack started on; down is positive. */
  readonly offset: number;
}

export interface WorkspaceStack {
  readonly rows: readonly WorkspaceStackRow[];
  /** Px between rows, where the window chrome shows. */
  readonly gap: number;
}

interface SwitchHost {
  /** Takes the wheel: the strip and its chrome. */
  root: HTMLElement;
  scroller: HTMLElement;
  stage: HTMLElement;
  gap: () => number;
  /** The overview owns the stage. */
  blocked: () => boolean;
  /** Every pane of the focused workspace shows (not below md, nothing maximized). */
  stripShown: () => boolean;
}

interface Gesture {
  start: number;
  tracker: SwipeTracker;
  pitch: number;
  center: WorkspaceStackRow;
  up: string | null;
  down: string | null;
  min: number;
  max: number;
}

interface WheelStream {
  owned: boolean;
  last: number;
  discrete: boolean;
  tail: WheelTail;
  /** The keyboard or the overview took over; the rest of the stream is swallowed. */
  cancelled: boolean;
}

/** niri's Mod+Wheel cooldown: one notch steps, later notches inside it are dropped. */
const WHEEL_STEP_COOLDOWN_MS = 150;

let host: SwitchHost | null = null;
/** Set a couple of frames after the host mounts: restoring a route does not animate. */
let ready = false;
let stack: WorkspaceStack | null = null;
let position = 0;
let run: MotionRun | null = null;
let gesture: Gesture | null = null;
let stream: WheelStream | null = null;
/**
 * The stream the idle timer last closed. An event stamped inside its idle
 * gap was queued behind a stall and still belongs to it: it reopens with its
 * owner and its tail, so a late tail never starts a switch of its own.
 */
let closed: WheelStream | null = null;
let streamTimer: number | null = null;
let lastStep = Number.NEGATIVE_INFINITY;
/**
 * The last trackpad delta a swipe took, and whether it was momentum. A
 * stall on the main thread can split one stream in two; a stream that picks
 * up a tail's motion right after is still that tail and is swallowed, so it
 * cannot step again. Fingers still moving start a gesture as usual.
 */
let lastMotion: { delta: number; time: number; tail: boolean } | null = null;
const SPLIT_TAIL_GAP_MS = 400;
/** The store change a gesture's release makes is not a new switch. */
let committing = false;
/** Each workspace's horizontal scroll when it was last on screen. */
const cameras = new Map<string, number>();
const listeners = new Set<() => void>();

function setStack(next: WorkspaceStack | null): void {
  stack = next;
  for (const listener of listeners) listener();
}

export function useWorkspaceStack(): WorkspaceStack | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => stack,
  );
}

/** The stage's transform with the stack at `p` rows; % of the stage's own height survives a resize. */
function stackTransform(p: number, gap: number): string {
  return `translateY(calc(${-p * 100}% - ${p * gap}px))`;
}

function currentPosition(): number {
  return run ? run.value() : position;
}

function writePosition(p: number): void {
  position = p;
  if (host && stack) host.stage.style.transform = stackTransform(p, stack.gap);
}

/** Re-apply the stack's transform after the host renders it. */
export function applyWorkspaceStackTransform(): void {
  if (host && stack && !run) host.stage.style.transform = stackTransform(position, stack.gap);
}

function focusedId(): string {
  return useLayoutStore.getState().layout.focusedWorkspaceId;
}

function ensureStack(fromId: string): WorkspaceStack {
  if (stack) return stack;
  settleStripCamera();
  if (host) cameras.set(fromId, host.scroller.scrollLeft);
  position = 0;
  const next = { rows: [{ id: fromId, offset: 0 }], gap: Math.round(host?.gap() ?? 0) };
  setStack(next);
  return next;
}

/**
 * Put `id` next to `from` on the side the motion heads. Rows out of sight
 * make room; a row already there stays.
 */
function placeRow(id: string, from: WorkspaceStackRow, direction: 1 | -1): WorkspaceStackRow {
  const current = ensureStack(from.id);
  const offset = from.offset + direction;
  const existing = current.rows.find((row) => row.id === id);
  if (existing?.offset === offset) return existing;
  const p = currentPosition();
  const row = { id, offset };
  const rows = current.rows.filter(
    (candidate) =>
      candidate.id !== id &&
      candidate.offset !== offset &&
      (candidate === from || Math.abs(candidate.offset - p) < 1),
  );
  setStack({ ...current, rows: [...rows, row].toSorted((a, b) => a.offset - b.offset) });
  return row;
}

function rowOf(id: string): WorkspaceStackRow | null {
  return stack?.rows.find((row) => row.id === id) ?? null;
}

/** Done moving and resting on the focused workspace: back to the plain strip. */
/**
 * Back to the plain strip. The host also clears the transform once it
 * renders the strip; clearing here covers a stack it never got to render.
 */
function endStack(): void {
  setStack(null);
  if (host) host.stage.style.transform = "";
}

function settle(): void {
  if (gesture || run || !stack) return;
  const row = rowOf(focusedId());
  if (row && Math.abs(row.offset - position) < 1e-3) endStack();
}

function springTo(offset: number, velocity?: number): void {
  if (!host || !stack) return;
  const from = currentPosition();
  const v = velocity ?? run?.velocity() ?? 0;
  run?.cancel();
  run = null;
  const motion = MotionAnimation.start("workspace-switch", from, offset, v);
  const { gap } = stack;
  // The end state is the element's own style; the animation plays over it.
  host.stage.style.transform = stackTransform(offset, gap);
  position = offset;
  let started: MotionRun | null = null;
  started = playMotion(
    host.stage,
    motion,
    (value) => ({ transform: stackTransform(value, gap) }),
    () => {
      if (run === started) run = null;
      settle();
    },
  );
  run = motion.durationMs > 0 ? started : null;
  settle();
}

function indexIn(layout: LayoutState, id: string): number {
  return layout.workspaces.findIndex((workspace) => workspace.id === id);
}

/** Which way `toId` lies from `fromId`: the order before the change, or after it for a new one. */
function directionOf(previous: LayoutState, next: LayoutState, fromId: string, toId: string) {
  let a = indexIn(previous, fromId);
  let b = indexIn(previous, toId);
  if (a < 0 || b < 0) {
    a = indexIn(next, fromId);
    b = indexIn(next, toId);
  }
  return a >= 0 && b >= 0 && b < a ? -1 : 1;
}

/** Focus moved to another workspace by anything but a swipe: spring there. */
function onFocusedWorkspaceChange(previous: LayoutState, next: LayoutState): void {
  if (!host || !ready || committing || host.blocked()) return;
  // No motion (reduced motion, or off): the strip just shows the new workspace.
  if (resolveMotion("workspace-switch").config.kind === "off") {
    finishWorkspaceSwitch();
    return;
  }
  const fromId = previous.focusedWorkspaceId;
  const toId = next.focusedWorkspaceId;
  // Keyboard during a swipe: the swipe ends here, the rest of its stream is swallowed.
  if (gesture) {
    position = currentGesturePosition(gesture);
    gesture = null;
    if (stream) stream.cancelled = true;
  }
  const current = ensureStack(fromId);
  const from = rowOf(fromId) ?? current.rows[0]!;
  const target = placeRow(toId, from, directionOf(previous, next, fromId, toId));
  springTo(target.offset);
}

function currentGesturePosition(active: Gesture): number {
  const raw = active.start + active.tracker.pos / active.pitch;
  return rubberBandClamp(WORKSPACE_RUBBER_BAND, active.min, active.max, raw);
}

function beginGesture(): void {
  if (!host) return;
  const id = focusedId();
  const current = ensureStack(id);
  const p = currentPosition();
  run?.cancel();
  run = null;
  position = p;
  // The workspace nearest the eye, and its neighbors: one swipe moves one workspace.
  const center =
    current.rows.find((row) => row.offset === Math.round(p)) ?? rowOf(id) ?? current.rows[0]!;
  const { workspaces } = useLayoutStore.getState().layout;
  const index = workspaces.findIndex((workspace) => workspace.id === center.id);
  const up = index > 0 ? workspaces[index - 1]!.id : null;
  const down = index >= 0 ? (workspaces[index + 1]?.id ?? null) : null;
  gesture = {
    start: p,
    tracker: new SwipeTracker(),
    pitch: host.scroller.clientHeight + current.gap,
    center,
    up,
    down,
    min: center.offset - (up ? 1 : 0),
    max: center.offset + (down ? 1 : 0),
  };
  writePosition(p);
}

function updateGesture(delta: number, time: number): void {
  const active = gesture;
  if (!active) return;
  active.tracker.push(delta, time);
  const raw = active.start + active.tracker.pos / active.pitch;
  // Mount the neighbor the fingers head for, once.
  if (
    raw > active.center.offset &&
    active.down &&
    rowOf(active.down)?.offset !== active.center.offset + 1
  ) {
    placeRow(active.down, active.center, 1);
  } else if (
    raw < active.center.offset &&
    active.up &&
    rowOf(active.up)?.offset !== active.center.offset - 1
  ) {
    placeRow(active.up, active.center, -1);
  }
  writePosition(rubberBandClamp(WORKSPACE_RUBBER_BAND, active.min, active.max, raw));
}

/** The fingers lifted: snap to where the swipe would have coasted, with its velocity. */
function endGesture(time: number): void {
  const active = gesture;
  if (!active) return;
  // An idle stretch before the end lowers the velocity, as in niri.
  active.tracker.push(0, time);
  gesture = null;
  const raw = active.start + active.tracker.pos / active.pitch;
  const projected = active.start + active.tracker.projectedEndPos() / active.pitch;
  const target = Math.round(Math.min(active.max, Math.max(active.min, projected)));
  const velocity =
    (active.tracker.velocity() / active.pitch) *
    rubberBandClampDerivative(WORKSPACE_RUBBER_BAND, active.min, active.max, raw);
  const direction = target > active.center.offset ? 1 : -1;
  const id =
    target === active.center.offset ? active.center.id : direction === 1 ? active.down : active.up;
  if (id === null) return springTo(active.center.offset, velocity);
  const row =
    target === active.center.offset ? active.center : placeRow(id, active.center, direction);
  if (id !== focusedId()) {
    committing = true;
    try {
      useLayoutStore.getState().focusWorkspace(id);
    } finally {
      committing = false;
    }
  }
  springTo(row.offset, velocity);
}

/** A wheel notch: one workspace, behind niri's cooldown. Never opens a new workspace. */
function stepWorkspace(direction: 1 | -1, time: number): void {
  if (time - lastStep < WHEEL_STEP_COOLDOWN_MS) return;
  lastStep = time;
  const { layout } = useLayoutStore.getState();
  const index = indexIn(layout, layout.focusedWorkspaceId);
  const next = layout.workspaces[index + direction];
  if (next) useLayoutStore.getState().focusWorkspace(next.id);
}

function layoutModifierHeld(event: WheelEvent): boolean {
  return isMacPlatform(navigator.platform)
    ? event.metaKey && event.altKey
    : event.ctrlKey && event.altKey;
}

function closeStream(time: number): void {
  if (streamTimer !== null) window.clearTimeout(streamTimer);
  streamTimer = null;
  closed = stream;
  stream = null;
  if (gesture) endGesture(time);
}

function onWheel(event: WheelEvent): void {
  if (!host || host.blocked()) return;
  const time = event.timeStamp;
  if (stream && time - stream.last > WHEEL_STREAM_IDLE_MS) closeStream(time);
  const dy = wheelDeltaPx(event.deltaY, event);
  const dx = wheelDeltaPx(event.deltaX, event);
  if (!stream && closed && time - closed.last <= WHEEL_STREAM_IDLE_MS) stream = closed;
  if (!stream) {
    if (dx === 0 && dy === 0) return;
    // The axis locks for the whole stream, as niri's gestures do.
    const vertical = Math.abs(dy) > Math.abs(dx);
    const carried =
      lastMotion !== null &&
      lastMotion.tail &&
      time - lastMotion.time < SPLIT_TAIL_GAP_MS &&
      Math.abs(lastMotion.delta) >= 3 &&
      Math.sign(dy) === Math.sign(lastMotion.delta) &&
      Math.abs(dy) >= Math.abs(lastMotion.delta) / 2;
    stream = {
      // Only Mod+scroll owns the workspace (pen ZlxmK). Content edges and
      // momentum never grant ownership, even after a gap splits the stream.
      owned: vertical && layoutModifierHeld(event),
      last: time,
      discrete: isDiscreteWheel(event),
      tail: new WheelTail(),
      cancelled: carried && !isDiscreteWheel(event),
    };
  }
  stream.last = time;
  // Unowned streams have no gesture to settle. Their idle gap is checked on
  // the next event, without scheduling a timer for every native scroll tick.
  // A content scroll's tail still counts, so a stall that splits it cannot
  // start a switch at the scroller's edge.
  if (!stream.owned) {
    if (dy !== 0 && !stream.discrete && Math.abs(dy) > Math.abs(dx)) {
      const kind = stream.tail.push(dy, time);
      lastMotion = { delta: dy, time, tail: kind === "tail" || kind === "lifted" };
    }
    return;
  }
  if (streamTimer !== null) window.clearTimeout(streamTimer);
  const armed = stream;
  streamTimer = window.setTimeout(() => {
    // Wheel events queued behind a stall arrive before the next frame's
    // callbacks: only a stream still quiet then has ended.
    window.requestAnimationFrame(() => {
      if (stream === armed && armed.last === time) closeStream(performance.now());
    });
  }, WHEEL_STREAM_IDLE_MS);
  event.preventDefault();
  event.stopPropagation();
  if (dy === 0) return;
  if (stream.discrete || isDiscreteWheel(event)) {
    if (!stream.cancelled) stepWorkspace(dy > 0 ? 1 : -1, time);
    return;
  }
  if (stream.cancelled) {
    lastMotion = { delta: dy, time, tail: true };
    return;
  }
  const raw = gesture ? gesture.start + gesture.tracker.pos / gesture.pitch : 0;
  const pastEdge = gesture !== null && (raw < gesture.min || raw > gesture.max);
  const kind = stream.tail.push(dy, time, pastEdge);
  lastMotion = { delta: dy, time, tail: kind === "tail" || kind === "lifted" };
  if (kind === "tail") return;
  if (kind === "resumed" || !gesture) beginGesture();
  updateGesture(dy, time);
  if (kind === "lifted") endGesture(time);
}

/**
 * Keyboard focus inside the workspace: the camera starts on the keypress
 * frame, before the store and React catch up (see layoutStore's `focusSoon`).
 * The same geometry the host scrolls by; false hands the focus back to land
 * at once.
 */
function anticipateFocus(_from: LayoutState, to: LayoutState): boolean {
  if (!host || stack || host.blocked() || !host.stripShown()) return false;
  const { scroller, stage } = host;
  const width = scroller.clientWidth;
  const workspace = selectFocusedWorkspace(to);
  const { whenNoRoom } = getLayoutBehavior();
  const { slots, stripWidth } = selectLayoutPaneSlots(workspace, { width, whenNoRoom });
  const slot = slots.find((candidate) => candidate.paneId === workspace.focusedPaneId);
  if (!slot) return true;
  const stripPx = stripWidth * width;
  const left = Math.round(slot.rect.left * stripPx);
  const right = left + Math.round(slot.rect.width * stripPx);
  const viewLeft = scroller.scrollLeft;
  if (left < viewLeft - 1) moveStripCamera(scroller, stage, left);
  else if (right > viewLeft + width + 1)
    moveStripCamera(scroller, stage, Math.min(left, right - width));
  // Already in view, the camera stays: nothing to paint ahead of React, so
  // the focus lands at once instead of a frame later.
  else return false;
  return true;
}

/**
 * The surface host's stage and the store, wired up while it is mounted.
 * Returns the cleanup.
 */
export function attachWorkspaceSwitch(next: SwitchHost): () => void {
  host = next;
  ready = false;
  let frame = window.requestAnimationFrame(() => {
    frame = window.requestAnimationFrame(() => {
      ready = true;
    });
  });
  const unsubscribe = useLayoutStore.subscribe((state, previous) => {
    if (state.layout.focusedWorkspaceId === previous.layout.focusedWorkspaceId) return;
    if (state.overviewOpen || next.blocked()) return;
    onFocusedWorkspaceChange(previous.layout, state.layout);
  });
  const stopAnticipating = setLayoutFocusAnticipation(anticipateFocus);
  next.root.addEventListener("wheel", onWheel, { passive: false, capture: true });
  return () => {
    window.cancelAnimationFrame(frame);
    unsubscribe();
    stopAnticipating();
    next.root.removeEventListener("wheel", onWheel, true);
    finishWorkspaceSwitch();
    if (host === next) host = null;
  };
}

/** Jump to the end of any switch at once, the way the overview needs. */
export function finishWorkspaceSwitch(): { rowOffset: number; scrollLeft: number | null } {
  if (!stack) return { rowOffset: 0, scrollLeft: null };
  const p = gesture ? currentGesturePosition(gesture) : currentPosition();
  const id = focusedId();
  const row = rowOf(id);
  run?.cancel();
  run = null;
  gesture = null;
  if (stream) stream.cancelled = true;
  position = row?.offset ?? 0;
  endStack();
  return { rowOffset: row ? p - row.offset : 0, scrollLeft: cameras.get(id) ?? null };
}

/**
 * Where a row's camera sits: where its workspace was last scrolled, moved
 * just enough to show its focused pane.
 */
export function workspaceStackCamera(
  workspace: LayoutWorkspace,
  slots: readonly LayoutPaneSlot[],
  stripPx: number,
  width: number,
): number {
  let scroll = cameras.get(workspace.id) ?? 0;
  const slot = slots.find((candidate) => candidate.paneId === workspace.focusedPaneId);
  if (slot) {
    const left = Math.round(slot.rect.left * stripPx);
    const right = left + Math.round(slot.rect.width * stripPx);
    if (left < scroll - 1) scroll = left;
    else if (right > scroll + width + 1) scroll = Math.min(left, right - width);
  }
  return Math.max(0, Math.min(stripPx - width, scroll));
}

/** The host drew a row at `camera`; the strip lands there when the stack ends on it. */
export function rememberWorkspaceCamera(id: string, camera: number): void {
  cameras.set(id, camera);
}

export function workspaceCamera(id: string): number | null {
  return cameras.get(id) ?? null;
}
