import type { ScreenReaderAnnouncements } from "@t3tools/contracts";
import { memo, useEffect, useRef } from "react";

import { useLiveRegion } from "../../hooks/useLiveRegion";
import type { TimelineEntry } from "../../session-logic";

import {
  nextThreadAnnouncement,
  type ThreadActivitySnapshot,
  type ThreadAnnouncementMemory,
} from "@t3tools/client-runtime/state/thread-activity-announcement";
import {
  nextTurnDetailAnnouncement,
  NO_TURN_DETAIL,
  turnDetail,
  type TurnDetailMemory,
} from "./turnDetailAnnouncement";

// Long enough for a screen reader to finish a short label before the next one.
const ACTIVITY_GAP_MS = 2_000;
// A polite region queues what it can't say yet, so steps written while a
// message is still being read would all be heard late. They wait this long.
const MESSAGE_HOLD_MS_PER_CHARACTER = 50;
const MESSAGE_HOLD_MAX_MS = 15_000;

function holdAfter(text: string) {
  return Math.min(
    MESSAGE_HOLD_MAX_MS,
    Math.max(ACTIVITY_GAP_MS, text.length * MESSAGE_HOLD_MS_PER_CHARACTER),
  );
}

/** One write, since a second write to a region replaces the first before it is heard. */
function asOneAnnouncement(texts: ReadonlyArray<string>) {
  return texts
    .map((text, index) => (index === texts.length - 1 || /[.!?:…]$/.test(text) ? text : `${text}.`))
    .join(" ");
}

/**
 * The open thread's polite live regions. Status has its own, so "Needs
 * approval" landing a moment after a message doesn't replace it unheard.
 */
export const ThreadActivityAnnouncer = memo(function ThreadActivityAnnouncer({
  threadKey,
  status,
  requestId,
  runId,
  runStatus,
  detailBehind,
  level,
  entries,
  workspaceRoot,
}: ThreadActivitySnapshot & {
  /** Null while the timeline shows another thread during a switch. */
  readonly threadKey: string | null;
  /** See isDetailBehindShell. */
  readonly detailBehind: boolean;
  readonly level: ScreenReaderAnnouncements;
  /** The thread's entries before any are hidden; unread at the "status" level. */
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly workspaceRoot: string | undefined;
}) {
  const { regionRef, announce, clear } = useLiveRegion();
  const {
    regionRef: detailRegionRef,
    announce: announceDetail,
    clear: clearDetail,
  } = useLiveRegion();
  const memoryRef = useRef<{
    threadKey: string;
    level: ScreenReaderAnnouncements;
    memory: ThreadAnnouncementMemory;
    detail: TurnDetailMemory;
  } | null>(null);
  // Messages are written at once; a step waits its turn, and a newer one replaces it.
  const stepRef = useRef<{
    quietUntil: number;
    waiting: { label: string; timer: ReturnType<typeof setTimeout> } | null;
  }>({ quietUntil: 0, waiting: null });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the turn's status, messages and steps to the aria-live region after commit
  useEffect(() => {
    const step = stepRef.current;
    const write = (text: string, quietMs: number) => {
      announceDetail(text);
      step.quietUntil = Date.now() + quietMs;
    };
    const takeWaiting = () => {
      const label = step.waiting?.label ?? null;
      if (step.waiting !== null) clearTimeout(step.waiting.timer);
      step.waiting = null;
      return label;
    };

    if (threadKey === null) {
      takeWaiting();
      memoryRef.current = null;
      clear();
      clearDetail();
      return;
    }
    const waitingLabel = takeWaiting();
    if (detailBehind) {
      // The dropped step counts as unsaid, so it is read once the detail catches up.
      if (waitingLabel !== null && memoryRef.current !== null) {
        const { detail } = memoryRef.current;
        memoryRef.current = { ...memoryRef.current, detail: { ...detail, activity: null } };
      }
      return;
    }
    const previous = memoryRef.current?.threadKey === threadKey ? memoryRef.current : null;
    const turn = nextThreadAnnouncement(previous?.memory ?? null, {
      status,
      requestId,
      runId,
      runStatus,
    });
    // A new level starts from what the turn already holds, so raising it mid-turn replays nothing.
    const previousDetail = previous?.level === level ? previous.detail : null;
    const detail = nextTurnDetailAnnouncement(previousDetail, {
      ...(level === "status"
        ? NO_TURN_DETAIL
        : turnDetail(entries, workspaceRoot, previousDetail?.tailId ?? null)),
      level,
      status,
    });
    memoryRef.current = { threadKey, level, memory: turn.memory, detail: detail.memory };
    if (previous === null) {
      step.quietUntil = 0;
      clear();
      clearDetail();
      return;
    }
    if (detail.messages.length > 0) {
      // NVDA reads two regions written in the same frame in either order, so a
      // status that lands with a message is read as its last sentence.
      const text = asOneAnnouncement(
        turn.announcement === null ? detail.messages : [...detail.messages, turn.announcement],
      );
      write(text, holdAfter(text));
    } else if (turn.announcement !== null) {
      announce(turn.announcement);
      step.quietUntil = Math.max(step.quietUntil, Date.now() + ACTIVITY_GAP_MS);
    }
    // A waiting label is stale once its step is over or the level no longer reads steps.
    const label =
      level !== "everything" || detail.memory.activity === null
        ? null
        : (detail.activity ?? waitingLabel);
    if (label === null) return;
    const speakStep = () => {
      step.waiting = null;
      write(label, ACTIVITY_GAP_MS);
    };
    const wait = step.quietUntil - Date.now();
    if (wait <= 0) {
      speakStep();
      return;
    }
    const timer = setTimeout(speakStep, wait);
    step.waiting = { label, timer };
    // The next run takes the label over; after an unmount nothing is left to speak it.
    return () => clearTimeout(timer);
  }, [
    threadKey,
    status,
    requestId,
    runId,
    runStatus,
    detailBehind,
    level,
    entries,
    workspaceRoot,
    announce,
    clear,
    announceDetail,
    clearDetail,
  ]);

  // No role="status": Orca 50 maps it to a status bar in Chromium and drops its updates.
  return (
    <>
      <div ref={detailRegionRef} aria-live="polite" className="sr-only" />
      <div ref={regionRef} aria-live="polite" className="sr-only" />
    </>
  );
});
