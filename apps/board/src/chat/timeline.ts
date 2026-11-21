import type { ThreadId, TurnItemId } from "@t3tools/contracts";

export type StepKind = "command" | "read" | "edit" | "search" | "agent" | "tool";

/** Where the engine keeps the output of a call it left out of the thread, which the work log fetches on open. */
export interface OutputRef {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly revision: string;
}

export interface ToolStep {
  readonly id: string;
  readonly label: string;
  readonly running: boolean;
  readonly failed: boolean;
  readonly family: StepKind;
  /** What the call was given: the shell command, the agent's prompt, or a tool's input as JSON. */
  readonly input: string | null;
  readonly exitCode: number | null;
  /** The file an edit changed, with its line counts. */
  readonly file: {
    readonly name: string;
    /** Absent when the engine did not count the lines. */
    readonly additions: number | null;
    readonly deletions: number | null;
  } | null;
  /** What the call printed, or why a failed edit failed, when the engine sent it with the item. */
  readonly output: string | null;
  readonly outputRef: OutputRef | null;
}

export type TimelineRow =
  | {
      readonly kind: "user";
      readonly id: string;
      readonly text: string;
      /** When the thread recorded the message, in epoch milliseconds. */
      readonly at: number | null;
    }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly text: string;
      readonly streaming: boolean;
      readonly at: number | null;
      /** When the reply's turn began, for the elapsed time of one still running. */
      readonly turnStartedAt: number | null;
    }
  | { readonly kind: "work"; readonly id: string; readonly steps: ReadonlyArray<ToolStep> }
  | {
      readonly kind: "notice";
      readonly id: string;
      readonly text: string;
      readonly error: boolean;
    };

/** What the chat reads of a thread's turn items, in the order they happened. */
export type ChatItem =
  | {
      readonly kind: "user";
      readonly id: string;
      readonly messageId: string;
      readonly text: string;
      /** The engine left the text out because the thread's message holds it. */
      readonly textOmitted: boolean;
    }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly messageId: string;
      readonly runId: string | null;
      readonly text: string;
      readonly textOmitted: boolean;
      readonly streaming: boolean;
    }
  | ({ readonly kind: "tool" } & ToolStep)
  | {
      readonly kind: "notice";
      readonly id: string;
      readonly text: string;
      readonly error: boolean;
    };

/** The parts of a thread that the chat reads. */
export interface TimelineSource {
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly startedAt: number | null;
  }>;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly createdAt: number;
  }>;
  readonly items: ReadonlyArray<ChatItem>;
}

const LIVE_RUN = ["preparing", "queued", "starting", "running", "waiting"];

/** Whether the thread's latest run is still going, which is when Stop replaces Send. */
export const isRunLive = (projection: {
  readonly runs: ReadonlyArray<{ readonly status: string }>;
}): boolean => LIVE_RUN.includes(projection.runs.at(-1)?.status ?? "");

/**
 * The thread as chat rows: the user's messages, the orchestrator's replies, and each stretch of tool
 * calls folded into one row. A user message or reply whose text the engine left out is read from the
 * thread's messages.
 */
export function timelineRows(projection: TimelineSource): ReadonlyArray<TimelineRow> {
  const textOf = (item: { messageId: string; text: string; textOmitted: boolean }) =>
    item.textOmitted
      ? (projection.messages.find((message) => message.id === item.messageId)?.text ?? "")
      : item.text;

  const createdAt = (item: { messageId: string }) =>
    projection.messages.find((message) => message.id === item.messageId)?.createdAt ?? null;

  const rows: TimelineRow[] = [];
  for (const item of projection.items) {
    switch (item.kind) {
      case "tool": {
        const { kind: _kind, ...step } = item;
        const last = rows.at(-1);
        if (last?.kind === "work")
          rows[rows.length - 1] = { ...last, steps: [...last.steps, step] };
        else rows.push({ kind: "work", id: item.id, steps: [step] });
        break;
      }
      case "user":
        rows.push({ kind: "user", id: item.id, text: textOf(item), at: createdAt(item) });
        break;
      case "assistant": {
        const text = textOf(item);
        rows.push({
          kind: "assistant",
          id: item.id,
          text,
          streaming: item.streaming,
          at: createdAt(item),
          turnStartedAt: projection.runs.find((run) => run.id === item.runId)?.startedAt ?? null,
        });
        break;
      }
      case "notice":
        rows.push(item);
        break;
    }
  }

  const ended = projection.runs.at(-1);
  if (ended?.status === "interrupted" || ended?.status === "cancelled") {
    rows.push({ kind: "notice", id: `${ended.id}:stopped`, text: "Stopped", error: false });
  }
  return rows;
}
