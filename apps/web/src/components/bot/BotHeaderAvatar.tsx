import type { ScopedThreadRef } from "@t3tools/contracts";

import { useQuietThreadShell } from "~/state/entities";
import { BotAvatar } from "./BotAvatar";
import { resolveBotStatus } from "./botStatus";
import { useBotBoard } from "./useBotBoard";

export function BotHeaderAvatar(props: { threadRef: ScopedThreadRef }) {
  const bot = useQuietThreadShell(props.threadRef);
  const board = useBotBoard(props.threadRef);
  if (bot === null) return null;
  const status = resolveBotStatus(bot, board);
  return (
    <span className="mr-2 shrink-0">
      <BotAvatar
        threadId={bot.id}
        choice={bot.botConfig?.avatar}
        state={status.state}
        mood={status.mood}
        size={22}
        live
        followPointer
      />
    </span>
  );
}
