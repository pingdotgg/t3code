export interface ToolStep {
  readonly id: string;
  readonly label: string;
  readonly running: boolean;
  readonly failed: boolean;
}

export type TimelineRow =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly text: string;
      readonly streaming: boolean;
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
  readonly runs: ReadonlyArray<{ readonly id: string; readonly status: string }>;
  readonly messages: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  readonly items: ReadonlyArray<ChatItem>;
}

const LIVE_RUN = ["preparing", "queued", "starting", "running", "waiting"];

/** Whether the thread's latest run is still going, which is when Stop replaces Send. */
export const isRunLive = (projection: Pick<TimelineSource, "runs">): boolean =>
  LIVE_RUN.includes(projection.runs.at(-1)?.status ?? "");

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
        rows.push({ kind: "user", id: item.id, text: textOf(item) });
        break;
      case "assistant": {
        const text = textOf(item);
        if (text !== "" || item.streaming) {
          rows.push({ kind: "assistant", id: item.id, text, streaming: item.streaming });
        }
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
