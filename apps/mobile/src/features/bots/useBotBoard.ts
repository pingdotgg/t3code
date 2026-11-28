import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type BotAvatarStatus,
  resolveBotAvatarStatus,
} from "@t3tools/client-runtime/state/bot-avatar";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  botWorkersBoard,
  groupBots,
  workerStatus,
  type BotWorkersBoard,
} from "@t3tools/client-runtime/state/thread-grouping";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { environmentThreadShells } from "../../state/threads";
import { resolveThreadListV2RowStatus, threadHasUnseenCompletion } from "../threads/threadListV2";

/** A Bot's workers by what each needs, from the quiet shells so streaming doesn't re-render. */
export function useBotBoard(botRef: ScopedThreadRef): BotWorkersBoard<EnvironmentThreadShell> {
  const shells = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  return botWorkersBoard(groupBots(shells), scopedThreadKey(botRef));
}

export function resolveBotStatus(
  bot: EnvironmentThreadShell,
  board: BotWorkersBoard<EnvironmentThreadShell>,
): BotAvatarStatus {
  const status = resolveThreadListV2RowStatus(bot);
  return resolveBotAvatarStatus({
    failed: status === "failed" || status === "limited",
    botNeedsInput: workerStatus(bot) === "needs-input",
    botRunning: threadRuntimeIsActive(bot.runtime),
    workersNeedingYou: board.needsYou.length,
    workersWorking: board.working.length,
    hasUnseenReply: threadHasUnseenCompletion(bot),
  });
}
