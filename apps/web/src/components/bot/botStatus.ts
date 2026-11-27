import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { type BotCrewBoard, crewStatus } from "@t3tools/client-runtime/state/thread-grouping";
import type { AvatarState } from "open-bot-avatar";

import { resolveSidebarRowStatus } from "../Sidebar.logic";

export type BotAvatarState = Extract<AvatarState, "idle" | "working" | "waiting" | "blocked">;

export interface BotStatus {
  readonly state: BotAvatarState;
  /** Crew waiting on the user, plus the Bot itself when it is. */
  readonly needsYou: number;
}

export function resolveBotStatus(
  bot: EnvironmentThreadShell,
  board: BotCrewBoard<EnvironmentThreadShell>,
): BotStatus {
  const needsYou = board.needsYou.length + (crewStatus(bot) === "needs-input" ? 1 : 0);
  const botStatus = resolveSidebarRowStatus(bot);
  // Crew failures wake the Bot to handle them; only the Bot's own failure stops the crew.
  const state: BotAvatarState =
    botStatus === "failed" || botStatus === "limited"
      ? "blocked"
      : needsYou > 0
        ? "waiting"
        : threadRuntimeIsActive(bot.runtime) || board.working.length > 0
          ? "working"
          : "idle";
  return { state, needsYou };
}
