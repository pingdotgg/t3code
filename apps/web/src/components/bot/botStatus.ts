import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { type BotWorkersBoard, workerStatus } from "@t3tools/client-runtime/state/thread-grouping";
import { DONE_CYCLE_S, type AvatarMood, type AvatarState } from "open-bot-avatar";

import { hasUnseenCompletion, resolveSidebarRowStatus } from "../Sidebar.logic";

export type BotAvatarState = Extract<
  AvatarState,
  "idle" | "thinking" | "working" | "waiting" | "blocked"
>;

/**
 * How long a live moment lasts so the state's motion completes. A working avatar first turns its
 * ribbons 1.2-2.4 s in, for 1.5 s (open-bot-avatar's WORK_FIRST_S, WORK_FIRST_JITTER_S and
 * WORK_TURN_S); a done one celebrates for DONE_CYCLE_S. The rest move continuously.
 */
export function botLiveMomentMs(state: AvatarState): number {
  if (state === "working") return 4200;
  if (state === "done") return DONE_CYCLE_S * 1000;
  return 2000;
}

export interface BotStatus {
  readonly state: BotAvatarState;
  /** Happy while it has a reply you have not seen. */
  readonly mood: AvatarMood;
  /** Workers waiting on the user, plus the Bot itself when it is. */
  readonly needsYou: number;
}

export function resolveBotStatus(
  bot: EnvironmentThreadShell,
  board: BotWorkersBoard<EnvironmentThreadShell>,
): BotStatus {
  const needsYou = board.needsYou.length + (workerStatus(bot) === "needs-input" ? 1 : 0);
  const botStatus = resolveSidebarRowStatus(bot);
  // Worker failures wake the Bot to handle them; only the Bot's own failure stops the workers.
  // The Bot replying thinks (dots); only its workers running shows them at work (ribbons).
  const state: BotAvatarState =
    botStatus === "failed" || botStatus === "limited"
      ? "blocked"
      : needsYou > 0
        ? "waiting"
        : threadRuntimeIsActive(bot.runtime)
          ? "thinking"
          : board.working.length > 0
            ? "working"
            : "idle";
  const mood: AvatarMood = state === "idle" && hasUnseenCompletion(bot) ? "happy" : "neutral";
  return { state, mood, needsYou };
}
