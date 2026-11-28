import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { type BotWorkersBoard, workerStatus } from "@t3tools/client-runtime/state/thread-grouping";
import type { AvatarMood, AvatarState } from "open-bot-avatar";

import { hasUnseenCompletion, resolveSidebarRowStatus } from "../Sidebar.logic";

export type BotAvatarState = Extract<
  AvatarState,
  "idle" | "thinking" | "working" | "waiting" | "blocked"
>;

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
