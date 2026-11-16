import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { MessageId, ThreadId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  displayStateNote,
  NORMAL_DISPLAY,
  NORMAL_DISPLAY_MODE,
  resolveDisplayMode,
  threadDisplay,
  toldKey,
} from "@t3tools/shared/displayModes";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettings from "../../serverSettings.ts";

export interface DisplayModeCompactionNoteShape {
  /**
   * The note that tells a thread's agent its display mode and Dashboard after a compaction of its
   * conversation, or `undefined` for a thread that never had a note and is Normal with no Dashboard.
   * Its callers deliver the note it returns, so it records the display as told. It logs a failure and
   * returns `undefined`.
   */
  readonly noteAfterCompaction: (threadId: ThreadId) => Effect.Effect<string | undefined>;
  /** Whether the thread is in Normal, or `undefined` when the read fails, which it logs. */
  readonly isNormal: (threadId: ThreadId) => Effect.Effect<boolean | undefined>;
}

export class DisplayModeCompactionNote extends Context.Service<
  DisplayModeCompactionNote,
  DisplayModeCompactionNoteShape
>()("t3/fork/displayModeWrap/DisplayModeCompactionNote") {}

/** The provided note service, or `undefined` in a runtime without one, such as an adapter test. */
export const providedCompactionNote = Effect.serviceOption(DisplayModeCompactionNote).pipe(
  Effect.map(Option.getOrUndefined),
);

/**
 * What the thread's current agent was last told, as `toldKey` (the mode and the Dashboard switch),
 * or `unknown`. A thread with no row never had a note sent, so no conversation of it holds one. Told
 * nothing counts as told Normal with no Dashboard.
 */
export const createToldTable = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`CREATE TABLE IF NOT EXISTS fork_display_mode_told (
    thread_id TEXT PRIMARY KEY,
    mode_id TEXT NOT NULL
  )`,
).pipe(Effect.orDie);

export const layer: Layer.Layer<
  DisplayModeCompactionNote,
  never,
  SqlClient.SqlClient | ServerSettings.ServerSettingsService
> = Layer.effect(
  DisplayModeCompactionNote,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    yield* createToldTable;

    const noteAfterCompaction: DisplayModeCompactionNoteShape["noteAfterCompaction"] = Effect.fn(
      "DisplayModeCompactionNote.noteAfterCompaction",
    )(function* (threadId) {
      return yield* Effect.gen(function* () {
        const display = threadDisplay(yield* serverSettings.getSettings, threadId);
        const told = yield* sql`SELECT 1 FROM fork_display_mode_told WHERE thread_id = ${threadId}`;
        if (told.length === 0 && toldKey(display) === toldKey(NORMAL_DISPLAY)) return undefined;
        yield* sql`INSERT INTO fork_display_mode_told (thread_id, mode_id)
          VALUES (${threadId}, ${toldKey(display)})
          ON CONFLICT (thread_id) DO UPDATE SET mode_id = excluded.mode_id`;
        return displayStateNote(display);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Display mode note after compaction skipped", { threadId, cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      );
    });

    const isNormal: DisplayModeCompactionNoteShape["isNormal"] = Effect.fn(
      "DisplayModeCompactionNote.isNormal",
    )(function* (threadId) {
      return yield* serverSettings.getSettings.pipe(
        Effect.map(
          (settings) =>
            resolveDisplayMode(settings.threadDisplayModes[threadId]) === NORMAL_DISPLAY_MODE,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Display mode read for the send_to_user section failed", {
            threadId,
            cause,
          }).pipe(Effect.as(undefined)),
        ),
      );
    });

    return DisplayModeCompactionNote.of({ noteAfterCompaction, isNormal });
  }),
);

/**
 * Claude Code hooks for the thread's display mode notes. After each compaction they add the thread's
 * note to the main conversation; a subagent's compaction gets nothing, since the note is about the
 * user's screen. The prompt of a slash command gets its turn's `commandNote`, which counts as told only
 * then: a command that Claude runs locally never reaches the hook and leaves the note owed.
 */
export const claudeDisplayModeHooks = (input: {
  readonly notes: DisplayModeCompactionNoteShape | undefined;
  readonly threadId: ThreadId;
  readonly activeTurn: Effect.Effect<ProviderAdapter.ProviderAdapterV2TurnInput | undefined>;
  readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>;
  /**
   * Upstream's send_to_user section of the system prompt, which a conversation keeps from its start.
   * In each Claude process, the first user prompt in Normal gets it, a compaction in Normal gets it
   * again, and so does the first Normal prompt after another mode's prompt.
   */
  readonly sendToUserSection?: string;
}): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
  const { notes, threadId, activeTurn, runPromise, sendToUserSection } = input;
  let sectionOwed = true;
  const section = async () => {
    if (sendToUserSection === undefined || notes === undefined) return undefined;
    const normal = await runPromise(notes.isNormal(threadId));
    if (normal === false) sectionOwed = true;
    if (normal !== true || !sectionOwed) return undefined;
    sectionOwed = false;
    return sendToUserSection;
  };
  return notes === undefined
    ? {}
    : {
        UserPromptSubmit: [
          {
            hooks: [
              async (hookInput) => {
                if (
                  hookInput.hook_event_name !== "UserPromptSubmit" ||
                  hookInput.source === "system" ||
                  hookInput.agent_id !== undefined
                )
                  return {};
                const turn = await runPromise(activeTurn);
                const note =
                  hookInput.prompt.trim() === turn?.message.text.trim()
                    ? turn.commandNote
                    : undefined;
                if (note !== undefined) await runPromise(note.delivered);
                const context = [note?.text, await section()].filter((text) => text !== undefined);
                return context.length === 0
                  ? {}
                  : {
                      hookSpecificOutput: {
                        hookEventName: "UserPromptSubmit",
                        additionalContext: context.join("\n\n"),
                      },
                    };
              },
            ],
          },
        ],
        SessionStart: [
          {
            matcher: "compact",
            hooks: [
              async (input) => {
                if (input.agent_id !== undefined) return {};
                sectionOwed = true;
                const note = await runPromise(notes.noteAfterCompaction(threadId));
                const context = [note, await section()].filter((text) => text !== undefined);
                return context.length === 0
                  ? {}
                  : {
                      hookSpecificOutput: {
                        hookEventName: "SessionStart",
                        additionalContext: context.join("\n\n"),
                      },
                    };
              },
            ],
          },
        ],
      };
};

/** The developer message for Codex's `thread/inject_items` after a compaction of a T3 thread's conversation. */
export const codexCompactionNoteItems = Effect.fn("DisplayModeCompactionNote.codexItems")(
  function* (
    notes: DisplayModeCompactionNoteShape | undefined,
    threadId: ThreadId | null | undefined,
  ) {
    const note =
      notes === undefined || threadId == null
        ? undefined
        : yield* notes.noteAfterCompaction(threadId);
    return note === undefined
      ? []
      : [{ type: "message", role: "developer", content: [{ type: "input_text", text: note }] }];
  },
);

/**
 * `params` with a slash command's note added to that one `turn/start`, under a key unique to the
 * message, so the entry is new to Codex each time.
 */
export const withCodexCommandNote = <P extends { readonly additionalContext?: object | null }>(
  params: P,
  messageId: MessageId,
  note: ProviderAdapter.ProviderAdapterV2TurnInput["commandNote"],
): P =>
  note === undefined
    ? params
    : {
        ...params,
        additionalContext: {
          ...params.additionalContext,
          [`t3_display_mode_${messageId.replace(/[^\w.-]/g, "_")}`]: {
            kind: "application",
            value: note.text,
          },
        },
      };
