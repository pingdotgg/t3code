import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type BotAvatarStatus,
  resolveBotAvatarStatus,
} from "@t3tools/client-runtime/state/bot-avatar";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type BotWorkersBoard,
  botWorkersBoard,
  groupBots,
  workerStatus,
} from "@t3tools/client-runtime/state/thread-grouping";
import type { EnvironmentId } from "@t3tools/contracts";

import { resolveThreadListV2RowStatus, threadHasUnseenCompletion } from "../threads/threadListV2";

export interface HomeBotRow {
  readonly key: string;
  readonly bot: EnvironmentThreadShell;
  readonly status: BotAvatarStatus;
  /** The Bot and its workers: opening any of them keeps the Bot's row current. */
  readonly memberKeys: ReadonlyArray<string>;
}

export interface HomeBots {
  readonly rows: ReadonlyArray<HomeBotRow>;
  /** The threads the normal list shows: Bots and their workers live on the Bot's page. */
  readonly listedThreads: ReadonlyArray<EnvironmentThreadShell>;
}

const keyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

export function resolveHomeBotStatus(
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

/**
 * Bots sit above the thread list whatever the project filter, like web's sidebar. A search
 * lists every thread instead, so Bots and workers can be found there.
 */
export function buildHomeBots(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly searching: boolean;
}): HomeBots {
  const groups = groupBots(input.threads);
  if (groups.bots.length === 0 || input.searching) {
    return { rows: [], listedThreads: input.threads };
  }
  const rows = groups.bots
    .filter((bot) => input.environmentId === null || bot.environmentId === input.environmentId)
    .map((bot): HomeBotRow => {
      const key = keyOf(bot);
      const board = botWorkersBoard(groups, key);
      return {
        key,
        bot,
        status: resolveHomeBotStatus(bot, board),
        memberKeys: [key, ...[...board.needsYou, ...board.working, ...board.done].map(keyOf)],
      };
    });
  return {
    rows,
    listedThreads: input.threads.filter((thread) => !groups.botAndWorkerKeys.has(keyOf(thread))),
  };
}
