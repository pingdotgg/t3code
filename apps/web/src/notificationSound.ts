/**
 * Notification sound — plays a configurable chime when an agent needs the
 * user's attention (turn end, approval requested, or question asked).
 *
 * Three pieces:
 *   1. `deriveNotificationTriggers` — pure: detects rising-edge transitions
 *      from a prev/next thread shell map.
 *   2. `shouldPlay` — pure: applies user settings, focus rules, and throttle.
 *   3. `notificationSoundManager` — singleton: lazy-loads the audio element,
 *      reads runtime focus context, and plays the sound when allowed.
 */
import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import type { NotificationSoundFocusRule, UnifiedSettings } from "@t3tools/contracts/settings";

export const NOTIFICATION_THROTTLE_MS = 5000;
export const NOTIFICATION_SOUND_URL = "/sounds/notification.mp3";

/**
 * Minimal shell shape used by the notification triggers. Matches the relevant
 * subset of `OrchestrationThreadShell` so callers can pass the real shells
 * directly without remapping.
 */
export interface NotificationThreadShellLike {
  readonly archivedAt: string | null;
  readonly latestTurn: { readonly state: "running" | "completed" | "interrupted" | "error" } | null;
  readonly hasPendingApprovals: boolean;
  readonly hasActionableProposedPlan: boolean;
  readonly hasPendingUserInput: boolean;
}

export type NotificationTriggerKind = "turn-end" | "approval" | "question";

export interface NotificationTrigger {
  readonly threadId: ThreadId;
  readonly kind: NotificationTriggerKind;
}

export interface NotificationFocusContext {
  readonly documentVisible: boolean;
  readonly windowFocused: boolean;
  readonly currentThreadId: ThreadId | null;
}

export type NotificationSettingsSlice = Pick<
  UnifiedSettings,
  | "notificationSoundEnabled"
  | "notificationSoundOnTurnEnd"
  | "notificationSoundOnApproval"
  | "notificationSoundOnQuestion"
  | "notificationSoundFocusRule"
>;

export type ThreadShellMap = ReadonlyMap<ThreadId, NotificationThreadShellLike>;

const TERMINAL_TURN_STATES = new Set<
  NotificationThreadShellLike["latestTurn"] extends infer T
    ? T extends { state: infer S }
      ? S
      : never
    : never
>(["completed", "error", "interrupted"]);

/**
 * Detects rising-edge transitions across a snapshot of thread shells.
 *
 * `events` is reserved for future edge-case handling (e.g. coalescing
 * multiple transitions inside a single batch). It is currently unused; the
 * derivation is fully driven by the prev/next shell maps.
 */
export function deriveNotificationTriggers(
  prev: ThreadShellMap,
  next: ThreadShellMap,
  _events: readonly OrchestrationEvent[],
): NotificationTrigger[] {
  const triggers: NotificationTrigger[] = [];

  for (const [threadId, nextShell] of next) {
    if (nextShell.archivedAt !== null) {
      continue;
    }

    const previousShell = prev.get(threadId);
    if (previousShell === undefined) {
      // Bootstrap edge — skip to avoid spurious dings on initial load.
      continue;
    }

    // turn-end: prev was running, next is in a terminal state.
    if (
      previousShell.latestTurn?.state === "running" &&
      nextShell.latestTurn !== null &&
      TERMINAL_TURN_STATES.has(nextShell.latestTurn.state)
    ) {
      triggers.push({ threadId, kind: "turn-end" });
    }

    // approval: prev had no pending approval/plan, next does.
    const prevApproval =
      previousShell.hasPendingApprovals || previousShell.hasActionableProposedPlan;
    const nextApproval = nextShell.hasPendingApprovals || nextShell.hasActionableProposedPlan;
    if (!prevApproval && nextApproval) {
      triggers.push({ threadId, kind: "approval" });
    }

    // question: prev had no pending user input, next does.
    if (!previousShell.hasPendingUserInput && nextShell.hasPendingUserInput) {
      triggers.push({ threadId, kind: "question" });
    }
  }

  return triggers;
}

function triggerPassesFocusRule(
  trigger: NotificationTrigger,
  rule: NotificationSoundFocusRule,
  focus: NotificationFocusContext,
): boolean {
  switch (rule) {
    case "always":
      return true;
    case "unfocused-only":
      return !focus.documentVisible || !focus.windowFocused;
    case "unfocused-or-different-thread":
      return (
        !focus.documentVisible || !focus.windowFocused || trigger.threadId !== focus.currentThreadId
      );
  }
}

export function shouldPlay(
  triggers: readonly NotificationTrigger[],
  settings: NotificationSettingsSlice,
  focusContext: NotificationFocusContext,
  nowMs: number,
  lastPlayAtMs: number,
): boolean {
  if (!settings.notificationSoundEnabled) return false;

  const enabledByKind = (kind: NotificationTriggerKind): boolean => {
    switch (kind) {
      case "turn-end":
        return settings.notificationSoundOnTurnEnd;
      case "approval":
        return settings.notificationSoundOnApproval;
      case "question":
        return settings.notificationSoundOnQuestion;
    }
  };

  const enabledTriggers = triggers.filter((trigger) => enabledByKind(trigger.kind));
  if (enabledTriggers.length === 0) return false;

  const passesFocus = enabledTriggers.some((trigger) =>
    triggerPassesFocusRule(trigger, settings.notificationSoundFocusRule, focusContext),
  );
  if (!passesFocus) return false;

  if (nowMs - lastPlayAtMs < NOTIFICATION_THROTTLE_MS) return false;

  return true;
}

// ── Singleton manager ─────────────────────────────────────────────────────

type CurrentThreadIdAccessor = () => ThreadId | null;

class NotificationSoundManager {
  private audio: HTMLAudioElement | null = null;
  private lastPlayAtMs = 0;
  private getCurrentThreadId: CurrentThreadIdAccessor = () => null;

  setCurrentThreadAccessor(accessor: CurrentThreadIdAccessor): void {
    this.getCurrentThreadId = accessor;
  }

  private ensureAudio(): HTMLAudioElement | null {
    if (typeof document === "undefined") return null;
    if (this.audio === null) {
      const audio = new Audio(NOTIFICATION_SOUND_URL);
      audio.preload = "auto";
      audio.volume = 1;
      this.audio = audio;
    }
    return this.audio;
  }

  private buildFocusContext(): NotificationFocusContext {
    if (typeof document === "undefined") {
      return { documentVisible: true, windowFocused: true, currentThreadId: null };
    }
    const documentVisible = document.visibilityState === "visible";
    const windowFocused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
    return {
      documentVisible,
      windowFocused,
      currentThreadId: this.getCurrentThreadId(),
    };
  }

  maybePlay(triggers: readonly NotificationTrigger[], settings: NotificationSettingsSlice): void {
    if (triggers.length === 0) return;
    const focusContext = this.buildFocusContext();
    const nowMs = Date.now();
    if (!shouldPlay(triggers, settings, focusContext, nowMs, this.lastPlayAtMs)) {
      return;
    }
    const audio = this.ensureAudio();
    if (!audio) return;
    this.lastPlayAtMs = nowMs;
    try {
      audio.currentTime = 0;
    } catch {
      // Some browsers throw when setting currentTime before metadata loads.
    }
    void audio.play().catch((error) => {
      console.warn("[NOTIFICATION_SOUND] play failed", error);
    });
  }

  /**
   * Bypasses focus, throttle, and settings checks. Returns the play promise
   * so callers can show a toast on rejection (e.g. autoplay blocked).
   */
  async playTest(): Promise<void> {
    const audio = this.ensureAudio();
    if (!audio) {
      throw new Error("Audio playback is not available in this environment.");
    }
    try {
      audio.currentTime = 0;
    } catch {
      // ignore
    }
    await audio.play();
  }

  /** Test-only: reset internal state. */
  resetForTests(): void {
    this.audio = null;
    this.lastPlayAtMs = 0;
    this.getCurrentThreadId = () => null;
  }
}

export const notificationSoundManager = new NotificationSoundManager();
