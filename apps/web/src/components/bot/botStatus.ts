import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { type BotWorkersBoard, workerStatus } from "@t3tools/client-runtime/state/thread-grouping";
import {
  type BotAvatarStatus,
  resolveBotAvatarStatus,
} from "@t3tools/client-runtime/state/bot-avatar";
import { DONE_CYCLE_S, type AvatarState } from "open-bot-avatar";

import { hasUnseenCompletion, resolveSidebarRowStatus } from "../Sidebar.logic";

export type { BotAvatarState } from "@t3tools/client-runtime/state/bot-avatar";

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

export type BotStatus = BotAvatarStatus;

export function resolveBotStatus(
  bot: EnvironmentThreadShell,
  board: BotWorkersBoard<EnvironmentThreadShell>,
): BotStatus {
  const botStatus = resolveSidebarRowStatus(bot);
  return resolveBotAvatarStatus({
    failed: botStatus === "failed" || botStatus === "limited",
    botNeedsInput: workerStatus(bot) === "needs-input",
    botRunning: threadRuntimeIsActive(bot.runtime),
    workersNeedingYou: board.needsYou.length,
    workersWorking: board.working.length,
    hasUnseenReply: hasUnseenCompletion(bot),
  });
}
