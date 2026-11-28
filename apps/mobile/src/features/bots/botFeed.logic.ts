import { MessageId, type OrchestrationV2TurnItem, type ThreadId } from "@t3tools/contracts";

import {
  threadFeedRunIsUnsettled,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
} from "../../lib/threadActivity";

/** One row at the end of a running Bot's chat, in place of its tools and progress. */
export interface BotTypingFeedEntry {
  readonly type: "bot-typing";
  readonly id: "bot-typing";
  readonly createdAt: string;
  /** The last line of the running turn's latest progress message. */
  readonly detail?: string;
}

/** The Bot's opening line, shown before the user's first message; no turn ever wrote it. */
export interface BotGreeting {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly createdAt: string;
}

export interface BotFeedInput {
  readonly latestRun: ThreadFeedLatestRun | null;
  /** The Bot waits on the user's approval or answer, so it is not typing. */
  readonly awaitingUser: boolean;
  readonly greeting: BotGreeting | null;
}

type ActivityGroup = Extract<ThreadFeedEntry, { readonly type: "activity-group" }>;

// Rows that stand on their own in a chat, as on web, where they are timeline events.
const BOT_EVENT_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "fork",
  "handoff",
  "run_interrupt_request",
  "run_interrupt_result",
  "secret_request",
  "feedback_request",
  "link_request",
  "subagent",
]);

function botShowsActivity(activity: ThreadFeedActivity): boolean {
  if (activity.workEntry.questionAnswer !== undefined) return true;
  const { item } = activity.projectedItem;
  if (BOT_EVENT_ITEM_TYPES.has(item.type)) return true;
  if (item.type !== "error") return false;
  if (item.status === "failed") return true;
  // A usage limit still being waited out shows on its recovery card instead.
  return (
    item.retry === undefined &&
    !(item.failure.class === "usage_limit" && item.status !== "completed")
  );
}

/** The last assistant message of each response: the final reply of its turn. */
function finalReplyIds(feed: ReadonlyArray<ThreadFeedEntry>): ReadonlySet<string> {
  const lastByResponse = new Map<string, string>();
  let unkeyedResponse = 0;
  for (const entry of feed) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") {
      unkeyedResponse += 1;
      continue;
    }
    const key = entry.message.runId ? `run:${entry.message.runId}` : `unkeyed:${unkeyedResponse}`;
    lastByResponse.set(key, entry.message.id);
  }
  return new Set(lastByResponse.values());
}

function progressLine(
  feed: ReadonlyArray<ThreadFeedEntry>,
  activeRunId: string | null,
): string | undefined {
  const progress = feed.findLast(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.runId === activeRunId &&
      entry.message.text.trim() !== "",
  );
  if (progress?.type !== "message") return undefined;
  return progress.message.text
    .trim()
    .split("\n")
    .findLast((line) => line.trim() !== "")
    ?.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replaceAll("`", "")
    .trim();
}

/**
 * A Bot's chat: your messages, each turn's final reply, and what it asks or what fails. The setup
 * prompt opening a greeting-less Bot is written for the Bot, so it stays hidden. Keep one deriver
 * per feed: unchanged rows keep their identity, which the list's row memoization relies on.
 */
export function createBotFeedDeriver() {
  const groups = new WeakMap<ActivityGroup, ActivityGroup | null>();
  let greetingRow: Extract<ThreadFeedEntry, { readonly type: "message" }> | null = null;
  let typingRow: BotTypingFeedEntry | null = null;

  const filterGroup = (group: ActivityGroup): ActivityGroup | null => {
    const cached = groups.get(group);
    if (cached !== undefined) return cached;
    const activities = group.activities.filter(botShowsActivity);
    // Its neighbors are hidden, so a kept group never continues another work log.
    const next =
      activities.length === 0
        ? null
        : activities.length === group.activities.length && !group.continuesWorkLog
          ? group
          : {
              type: "activity-group" as const,
              id: group.id,
              createdAt: group.createdAt,
              runId: group.runId,
              activities,
            };
    groups.set(group, next);
    return next;
  };

  const greeting = (input: BotGreeting) => {
    if (
      greetingRow === null ||
      greetingRow.message.text !== input.text ||
      greetingRow.createdAt !== input.createdAt ||
      greetingRow.message.sourceThreadId !== input.threadId
    ) {
      const id = MessageId.make("bot-greeting");
      greetingRow = {
        type: "message",
        id,
        createdAt: input.createdAt,
        message: {
          id,
          role: "assistant",
          text: input.text,
          attachments: [],
          runId: null,
          streaming: false,
          visibility: "synthetic",
          sourceThreadId: input.threadId,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
      };
    }
    return greetingRow;
  };

  return (
    feed: ReadonlyArray<ThreadFeedEntry>,
    input: BotFeedInput,
  ): {
    readonly rows: ReadonlyArray<ThreadFeedEntry>;
    readonly typing: BotTypingFeedEntry | null;
  } => {
    const setupPromptId =
      input.greeting === null
        ? feed.find((entry) => entry.type === "message" && entry.message.role === "user")?.id
        : undefined;
    const running = threadFeedRunIsUnsettled(input.latestRun) && input.latestRun.turnEnded !== true;
    const activeRunId = running ? (input.latestRun?.runId ?? null) : null;
    const replies = finalReplyIds(feed);
    const rows: ThreadFeedEntry[] = input.greeting === null ? [] : [greeting(input.greeting)];
    for (const entry of feed) {
      if (entry.id === setupPromptId) continue;
      if (entry.type === "message") {
        const { message } = entry;
        if (
          message.role === "assistant" &&
          (!replies.has(message.id) || message.runId === activeRunId)
        )
          continue;
        rows.push(entry);
      } else if (entry.type === "activity-group") {
        const group = filterGroup(entry);
        if (group !== null) rows.push(group);
      } else if (
        entry.type === "html-render" ||
        entry.type === "sent-message" ||
        entry.type === "mcp-app"
      ) {
        rows.push(entry);
      }
    }
    if (!running || input.awaitingUser) return { rows, typing: null };
    const detail = progressLine(feed, activeRunId);
    const createdAt = input.latestRun?.startedAt ?? feed.at(-1)?.createdAt ?? "";
    if (typingRow === null || typingRow.detail !== detail || typingRow.createdAt !== createdAt) {
      typingRow = {
        type: "bot-typing",
        id: "bot-typing",
        createdAt,
        ...(detail === undefined ? {} : { detail }),
      };
    }
    return { rows, typing: typingRow };
  };
}
