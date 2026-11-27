import { T, Var } from "gt-react";
import { use } from "react";

import {
  TimelineRowActivityCtx,
  TimelineRowCtx,
  type TimelineRow,
} from "../chat/timelineRowContext";
import { BotAvatar } from "./BotAvatar";

/** The Bot's name and avatar above the first reply of its turn. */
export function BotReplyHeader() {
  const { bot } = use(TimelineRowCtx);
  if (bot === null) return null;
  return (
    <div className="flex items-center gap-2 px-1 pb-1 text-xs font-medium text-foreground/80">
      <BotAvatar threadId={bot.threadId} state="idle" size={20} />
      <span className="min-w-0 truncate">{bot.name}</span>
    </div>
  );
}

export function BotTypingTimelineRow() {
  const { bot } = use(TimelineRowCtx);
  // A Bot waiting on your answer is not typing.
  const { awaitingUser } = use(TimelineRowActivityCtx);
  if (bot === null || awaitingUser) return null;
  return (
    <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
      <BotAvatar threadId={bot.threadId} state="working" size={20} />
      <span className="min-w-0 truncate">
        <T>
          <Var>{bot.name}</Var> is typing…
        </T>
      </span>
    </div>
  );
}

export function BotWakeTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "bot-wake" }> }) {
  return <p className="min-w-0 px-1 text-xs text-muted-foreground wrap-anywhere">{row.label}</p>;
}
