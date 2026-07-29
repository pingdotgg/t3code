/**
 * Reader for Antigravity's trajectory transcript.
 *
 * Antigravity appends one JSON record per step to
 * `<brain>/<conversation-uuid>/.system_generated/logs/transcript.jsonl` while a
 * turn is running, not just at the end. Tailing it is what lets the bridge
 * stream assistant text and surface real tool output — neither of which the
 * hook payloads carry.
 *
 * The record format is undocumented. Everything here is written to degrade to
 * "emit nothing" rather than throw, so an Antigravity update that changes the
 * shape costs observability but never breaks a turn.
 *
 * @module provider/acp/antigravity/agyTranscript
 */
import type { AgySessionUpdate, AgyTurnState } from "./agyEvents.ts";

export interface AgyTranscriptRecord {
  readonly step_index?: number;
  readonly source?: string;
  readonly type?: string;
  readonly status?: string;
  readonly created_at?: string;
  readonly content?: string;
}

/**
 * Record types that are bookkeeping rather than conversation. `CHECKPOINT` in
 * particular holds a summary of truncated context and would read as the
 * assistant talking to itself.
 */
/**
 * Ceiling on a single held-back transcript line.
 *
 * The transcript is read incrementally, so nothing else bounds a record that
 * never terminates: the cursor would hold every byte of it waiting for a
 * newline. Generous enough that a real tool output is never truncated — the
 * largest observed records are a few hundred KiB.
 */
export const MAX_TRANSCRIPT_LINE_CHARS = 4 * 1024 * 1024;

const IGNORED_RECORD_TYPES = new Set([
  "CONVERSATION_HISTORY",
  "CHECKPOINT",
  "USER_INPUT",
  "SYSTEM_MESSAGE",
]);

export function parseTranscriptLine(line: string): AgyTranscriptRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parsed as AgyTranscriptRecord;
  } catch {
    // A partially-flushed final line is expected while tailing a live turn.
    return null;
  }
}

/**
 * Size of the complete parsed record retained by the bridge.
 *
 * Computed once when a record enters the deferred queue; callers carry the
 * result with the record instead of repeatedly serializing held entries.
 */
export function serializedTranscriptRecordSize(record: AgyTranscriptRecord): number {
  return JSON.stringify(record).length;
}

/**
 * Strip the `Created At:` / `Completed At:` preamble Antigravity prepends to
 * tool records, then dedent. Tool output arrives indented with tabs, which
 * would otherwise render as a code block in the client.
 */
export function normalizeToolOutput(content: string): string {
  const withoutTimestamps = content
    .split("\n")
    .filter((line) => !/^\s*(Created At|Completed At):/.test(line))
    .join("\n");

  // Antigravity indents its own framing ("The command exited with code 0.",
  // "Output:") with tabs while leaving the tool's real output flush left, so a
  // plain common-prefix dedent finds an indent of zero and does nothing.
  // Dedent across tab-indented lines only: that strips the framing here, and
  // still behaves like a normal dedent when the payload is tab-indented source.
  const lines = withoutTimestamps.split("\n");
  const tabDepths = lines
    .filter((line) => line.trim().length > 0 && line.startsWith("\t"))
    .map((line) => line.match(/^\t*/)?.[0].length ?? 0);
  const commonTabs = tabDepths.length > 0 ? Math.min(...tabDepths) : 0;
  const dedented =
    commonTabs > 0
      ? lines.map((line) => (line.startsWith("\t") ? line.slice(commonTabs) : line)).join("\n")
      : withoutTimestamps;

  return dedented.trim();
}

export interface TranscriptUpdateResult {
  readonly updates: ReadonlyArray<AgySessionUpdate>;
  /** True when the record produced assistant-visible text. */
  readonly emittedAssistantText: boolean;
  /**
   * True when the record belongs to a tool call that has not been announced
   * yet. The caller should hold it and try again after reading more hooks.
   */
  readonly deferred?: boolean;
}

/**
 * Translate one transcript record into ACP updates.
 *
 * Assistant text becomes an `agent_message_chunk`. A tool record is matched to
 * the in-flight tool call announced by the matching `PreToolUse` hook — the
 * hook's `stepIdx` and the record's `step_index` are the same number — and its
 * body is attached as that call's output.
 */
export function transcriptRecordUpdates(
  record: AgyTranscriptRecord,
  state: AgyTurnState,
): TranscriptUpdateResult {
  const type = record.type;
  if (!type || IGNORED_RECORD_TYPES.has(type)) {
    return { updates: [], emittedAssistantText: false };
  }

  const content = typeof record.content === "string" ? record.content : "";

  if (type === "PLANNER_RESPONSE") {
    const text = content.trim();
    if (text.length === 0) {
      return { updates: [], emittedAssistantText: false };
    }
    return {
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      ],
      emittedAssistantText: true,
    };
  }

  // Any other MODEL record is a tool step. Attach its body to the tool call
  // the hook already announced; without a matching hook there is no tool call
  // to update, so the output is dropped rather than invented.
  const stepIndex = record.step_index;
  if (typeof stepIndex !== "number") {
    return { updates: [], emittedAssistantText: false };
  }
  // Completed calls stay in the map precisely so this lookup still resolves:
  // a fast tool's `PostToolUse` hook and its transcript record routinely land
  // in the same drain pass, and hooks are read first.
  const active = state.toolCalls.get(stepIndex);
  if (!active) {
    // The hook directory is listed before the transcript is read, so a tool
    // whose `PreToolUse` file appeared in between has a record here and no
    // call yet. The transcript is consumed once by byte offset, so dropping it
    // loses that tool's output for good — it is held instead and retried once
    // the hook shows up.
    return { updates: [], emittedAssistantText: false, deferred: true };
  }
  // Recorded only once the record has actually been matched: marking a step
  // seen before that would tell the caller a tool it has not announced yet is
  // already finished.
  state.transcriptSeenSteps.add(stepIndex);
  const output = normalizeToolOutput(content);
  if (output.length === 0) {
    return { updates: [], emittedAssistantText: false };
  }

  return {
    updates: [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: active.toolCallId,
        content: [{ type: "content", content: { type: "text", text: output } }],
        _meta: { antigravity: { event: "transcript", recordType: type, stepIdx: stepIndex } },
      },
    ],
    emittedAssistantText: false,
  };
}

/**
 * Drop transcript records belonging to earlier turns.
 *
 * One conversation keeps a single append-only transcript, and every turn opens
 * with a `USER_INPUT` record, so the last one in the file marks where the
 * current turn begins. Resuming a conversation starts reading at byte 0 — the
 * turn's own records cannot be located any other way — which without this trim
 * would replay every prior assistant message as new output.
 *
 * Applied only to the first batch of a turn. Returns the input unchanged when
 * no `USER_INPUT` is present, which is the correct read for a transcript whose
 * opening record has not been written yet.
 */
export function dropPriorTurnRecords(lines: ReadonlyArray<string>): ReadonlyArray<string> {
  let lastUserInput = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (parseTranscriptLine(lines[index] ?? "")?.type === "USER_INPUT") {
      lastUserInput = index;
    }
  }
  return lastUserInput === -1 ? lines : lines.slice(lastUserInput + 1);
}

/**
 * Incremental transcript cursor.
 *
 * Tracks a byte offset and holds back a trailing partial line so a record that
 * is still being written is parsed once, on the next read, rather than twice.
 */
export class AgyTranscriptCursor {
  private offset = 0;
  private carry = "";
  /**
   * Set once a single record has grown past {@link MAX_TRANSCRIPT_LINE_CHARS}.
   * Its bytes keep arriving, so the remainder is swallowed up to the next
   * newline rather than surfacing as a fragment that parses as nothing.
   */
  private discarding = false;
  /**
   * Whole lines handed back by {@link retain}, kept apart from {@link carry}.
   *
   * They were once prepended to the carry, which put finished records into the
   * same buffer as a half-written one: retaining while a record was being
   * abandoned made the first retained line look like that record's tail, so it
   * was dropped and the real fragment emitted in its place.
   */
  private retained: Array<string> = [];

  get bytesConsumed(): number {
    return this.offset;
  }

  /** Size of everything held back, for callers enforcing their own budget. */
  get carryLength(): number {
    return this.retained.reduce((total, line) => total + line.length + 1, this.carry.length);
  }

  /**
   * Feed a freshly-read chunk starting at the current offset, returning whole
   * lines only.
   */
  push(chunk: string): ReadonlyArray<string> {
    this.offset += Buffer.byteLength(chunk, "utf8");
    const combined = this.carry + chunk;
    const lines = combined.split("\n");
    this.carry = lines.pop() ?? "";

    let completed: ReadonlyArray<string> = lines;
    if (this.discarding) {
      // The first line to complete here is the tail of the record that was
      // given up on; everything after it is intact.
      if (lines.length > 0) {
        completed = lines.slice(1);
        this.discarding = false;
      } else {
        completed = [];
      }
    }

    // A record with no newline in sight would otherwise be held in full, so a
    // single malformed or enormous transcript entry could exhaust memory no
    // matter how small each read is.
    if (this.carry.length > MAX_TRANSCRIPT_LINE_CHARS) {
      this.carry = "";
      this.discarding = true;
    }

    // Retained lines go back in front, where they were read from, and are not
    // subject to the discard above — they are complete records that have
    // already been through it once.
    if (this.retained.length > 0) {
      const restored = this.retained;
      this.retained = [];
      return [...restored, ...completed];
    }
    return completed;
  }

  /**
   * Push whole lines back to the front of the stream.
   *
   * Used when a batch cannot be interpreted yet — on a resumed conversation the
   * current turn's opening record may not have been written — so the same lines
   * are re-examined against the next read rather than emitted or discarded.
   */
  retain(lines: ReadonlyArray<string>): void {
    if (lines.length > 0) {
      this.retained.push(...lines);
    }
  }

  /**
   * Retain a candidate suffix only while all held transcript text fits within
   * the caller's budget.
   *
   * Resumed conversations are scanned from byte zero when no baseline was
   * measurable. Complete history is expendable on overflow, but the bounded
   * partial line may be the current turn's `USER_INPUT` boundary. Its caller
   * keeps suppressing completed records until that boundary is observed, so
   * preserving the partial line cannot surface historical output.
   */
  retainWithinLimit(lines: ReadonlyArray<string>, maxChars: number): boolean {
    const lineChars = lines.reduce((total, line) => total + line.length + 1, 0);
    if (this.carryLength + lineChars > maxChars) {
      this.retained = [];
      return false;
    }
    this.retain(lines);
    return true;
  }

  /** Flush the trailing line once the writer is known to be finished. */
  flush(): ReadonlyArray<string> {
    const remaining = this.carry;
    this.carry = "";
    // Retained records are whole and still owed to the caller even at EOF.
    const restored = this.retained;
    this.retained = [];
    if (this.discarding) {
      // Whatever is left of the carry is the tail of an abandoned record, not a
      // record. The retained lines are unaffected.
      this.discarding = false;
      return restored;
    }
    return remaining.trim().length > 0 ? [...restored, remaining] : restored;
  }
}
