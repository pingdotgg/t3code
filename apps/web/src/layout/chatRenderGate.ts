import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { flushSync } from "react-dom";

import { useComposerDraftStore } from "../composerDraftStore";
import { readThreadShell } from "../state/entities";
import type { ThreadRouteTarget } from "../threadRoutes";

/** A focused chat waiting for first render must intercept and replay its keys, or shortcuts can fall
 * through to desktop window actions. */
const waitingChats = new Map<string, () => void>();

export function registerWaitingChat(tabId: string, render: () => void): () => void {
  waitingChats.set(tabId, render);
  return () => {
    if (waitingChats.get(tabId) === render) waitingChats.delete(tabId);
  };
}

/**
 * Render the waiting chat now, committing its effects (and key listeners)
 * synchronously. Returns false when it was rendered already.
 */
export function renderWaitingChatNow(tabId: string | null): boolean {
  const render = tabId === null ? undefined : waitingChats.get(tabId);
  if (!render) return false;
  waitingChats.delete(tabId!);
  flushSync(render);
  return true;
}

/** Render one chat per task after a frame, prioritizing focus. Idle thumbnails wait behind chats so
 * typing never queues behind an entire workspace. */
type TurnPriority = "focused" | "normal" | "later";
const turns: { render: () => void; priority: TurnPriority }[] = [];
let frame: number | null = null;
let timer: number | null = null;
let backup: number | null = null;
let idle: number | null = null;
/** An idle moment that never comes (a busy window) still lets a later turn run. */
const LATER_TURN_MAX_WAIT_MS = 2000;

function takeTurn(): void {
  if (frame !== null) window.cancelAnimationFrame(frame);
  if (timer !== null) window.clearTimeout(timer);
  if (backup !== null) window.clearTimeout(backup);
  if (idle !== null) window.cancelIdleCallback(idle);
  frame = timer = backup = idle = null;
  const turn = turns.shift();
  if (turn) flushSync(turn.render);
  if (turns.length > 0) scheduleTurn();
}

/** After the next frame, so the pane that asked shows first. */
function scheduleTurn(): void {
  if (turns[0]?.priority === "later" && typeof window.requestIdleCallback === "function") {
    if (idle === null && frame === null && timer === null) {
      idle = window.requestIdleCallback(() => takeTurn(), { timeout: LATER_TURN_MAX_WAIT_MS });
    }
    return;
  }
  if (idle !== null) {
    window.cancelIdleCallback(idle);
    idle = null;
  }
  if (frame !== null || timer !== null) return;
  frame = window.requestAnimationFrame(() => {
    frame = null;
    timer = window.setTimeout(takeTurn, 0);
  });
  // A hidden window draws no frames; a timer backs the frame up.
  backup = window.setTimeout(takeTurn, 250);
}

/** Queue a chat's first render; returns the way to leave the queue. */
export function queueChatRender(render: () => void, priority: TurnPriority): () => void {
  const turn = { render, priority };
  const later = turns.findIndex((queued) => queued.priority === "later");
  if (priority === "focused") turns.unshift(turn);
  else if (priority === "later" || later === -1) turns.push(turn);
  else turns.splice(later, 0, turn);
  scheduleTurn();
  return () => {
    const index = turns.indexOf(turn);
    if (index >= 0) turns.splice(index, 1);
  };
}

const LIVE_RUNTIME_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * Whether an off-screen chat must stay rendered: a turn in flight, a send
 * still submitting, or an approval or question waiting on the user.
 */
export function chatHoldsLiveWork(target: ThreadRouteTarget): boolean {
  const drafts = useComposerDraftStore.getState();
  const session = target.kind === "draft" ? drafts.getDraftSession(target.draftId) : null;
  const threadRef =
    target.kind === "server"
      ? target.threadRef
      : session
        ? (session.promotedTo ?? scopeThreadRef(session.environmentId, session.threadId))
        : null;
  if (!threadRef) return false;
  if (drafts.backgroundSubmissionThreadKeys[scopedThreadKey(threadRef)]) return true;
  const shell = readThreadShell(threadRef);
  if (!shell) return false;
  return (
    shell.hasPendingApprovals ||
    shell.hasPendingUserInput ||
    (shell.runtime !== null && LIVE_RUNTIME_STATUSES.has(shell.runtime.status))
  );
}
