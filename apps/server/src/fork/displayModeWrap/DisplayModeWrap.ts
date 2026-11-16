import {
  isCompactionCommandMessage,
  type MessageId,
  OrchestrationV2TurnItemJson,
  type OrchestrationV2TurnItem,
  parseGoalCommand,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  type DisplayMode,
  DISPLAY_MODES,
  displayEventFromTurnItem,
  isMainListOnItsOwn,
  isWebTypedMessage,
  type MessageOrigin,
  NORMAL_DISPLAY_MODE,
  resolveDisplayMode,
  foldCores,
  SUB_THREAD_WINDOW_CORES,
  subThreadCores,
  subThreadOfRecords,
  WRAPPED_CORE_COUNT,
} from "@t3tools/shared/displayModes";
import { createOrchestrationV2TurnItemVisibility } from "@t3tools/shared/orchestrationV2Timeline";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { sendCallSql } from "../shownHistory/ShownHistory.ts";
import * as SubThreads from "../subThreads/SubThreads.ts";
import { createToldTable } from "./DisplayModeCompactionNote.ts";

/** The text that the agent gets for a message, and the step to run once the provider accepts it. */
export interface WrappedUserText {
  readonly text: string;
  /** Records the mode note in `text` as told. It logs a failure and does not fail. */
  readonly accepted: Effect.Effect<void>;
  /** The owed note of a slash command, which `text` cannot carry. Its `delivered` records it as told. */
  readonly commandNote?: ProviderAdapter.ProviderAdapterV2TurnInput["commandNote"];
}

/**
 * How the conversation of the agent that gets a message differs from the one its last note went to:
 * `"fresh"` is a new one with no notes, `"uncertain"` is the same one with history added from
 * elsewhere, and `{ copiedFrom }` is a copy of that thread's conversation, notes included.
 */
export type NoteContext = "fresh" | "uncertain" | { readonly copiedFrom: ThreadId };

/**
 * The note context of a turn start's agent, or `undefined` when it keeps the conversation its last
 * note went to. A native fork that fell back to portable context starts a new conversation.
 */
export const noteContextAtTurnStart = (input: {
  readonly sameNativeThread: boolean;
  readonly handoffCount: number;
  readonly nativeFork: { readonly sourceThreadId: ThreadId } | undefined;
  readonly portableForkFallback: object | undefined;
}): NoteContext | undefined => {
  if (input.sameNativeThread && input.handoffCount === 0) return undefined;
  if (input.nativeFork !== undefined && input.portableForkFallback === undefined)
    return { copiedFrom: input.nativeFork.sourceThreadId };
  return input.sameNativeThread ? "uncertain" : "fresh";
};

export interface DisplayModeWrapShape {
  /**
   * `message` starts or steers a turn; the display mode can add to `text`. Without `context`, the
   * agent's conversation is the one its last note went to. Only an accepted turn records its note,
   * so a retried start sends it again.
   */
  readonly wrapUserText: (input: {
    readonly threadId: ThreadId;
    readonly message: MessageOrigin & {
      readonly id: MessageId;
      readonly text: string;
      readonly attachments?: ReadonlyArray<unknown>;
      /** A reply's record names the first message of its sub-thread. */
      readonly context?: { readonly records: ReadonlyArray<unknown> } | undefined;
    };
    readonly text: string;
    readonly context?: NoteContext;
  }) => Effect.Effect<WrappedUserText>;
  /**
   * The user messages and send calls that the screen shows, oldest first, in any state. Reads back
   * past the user's last typed message and at least `cores` messages (default WRAPPED_CORE_COUNT),
   * counted from the item with `ownNativeId` back when given. With `toMainListMessage`, also past
   * the latest event that is in the main list on its own (`isMainListOnItsOwn`).
   */
  readonly latestShownItems: (
    threadId: ThreadId,
    ownNativeId?: string,
    cores?: number,
    toMainListMessage?: boolean,
  ) => Effect.Effect<
    ReadonlyArray<OrchestrationV2TurnItem>,
    SqlError.SqlError | Schema.SchemaError | ProjectionStore.ProjectionStoreV2Error
  >;
  /**
   * The thread's agent lost turns from its conversation, such as by a rollback, and they may have
   * held its mode note. It logs a failure and does not fail.
   */
  readonly forgetNotes: (threadId: ThreadId) => Effect.Effect<void>;
  /**
   * Runs `ingest`, which stores `input.event`. A compaction that the event finishes, for the first
   * time, and of a provider that does not send the note again itself, forgets the thread's notes.
   */
  readonly forgetNotesAfterCompaction: (input: {
    readonly threadId: ThreadId;
    readonly runId?: RunId;
    readonly event: ProviderAdapter.ProviderAdapterV2Event;
  }) => <A extends ReadonlyArray<unknown>, E, R>(
    ingest: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

const decodeTurnItem = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);

const decodePrompt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      role: Schema.String,
      text: Schema.String,
      attachments: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  ),
);

const PAGE_ROWS = 8;

/** A told mode that matches no mode, so the next typed message carries the current mode's note. */
const UNKNOWN_TOLD = "unknown";

/** Drivers that send the thread's note after each compaction themselves (DisplayModeCompactionNote). */
const NOTE_AFTER_COMPACTION_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/** A stretch of history that the thread's screen shows, read from `before` back to its start. */
interface Segment {
  readonly threadId: string;
  readonly before: { readonly ordinal: number; readonly itemId: string };
  readonly shows: (item: OrchestrationV2TurnItem) => boolean;
}

export class DisplayModeWrap extends Context.Service<DisplayModeWrap, DisplayModeWrapShape>()(
  "t3/fork/displayModeWrap/DisplayModeWrap",
) {}

/**
 * Removes the stored mode of each deleted thread. A deleted thread keeps its projection row,
 * with `deleted_at` set.
 */
export const pruneDeletedThreadModes = Effect.fn("DisplayModeWrap.pruneDeletedThreadModes")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const threadIds = Object.keys((yield* serverSettings.getSettings).threadDisplayModes);
    if (threadIds.length === 0) return;
    const deleted = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE thread_id IN ${sql.in(threadIds)} AND deleted_at IS NOT NULL
    `;
    if (deleted.length === 0) return;
    yield* serverSettings.updateSettings({
      threadDisplayModes: Object.fromEntries(deleted.map((row) => [row.thread_id, null])),
    });
  },
);

export const layer: Layer.Layer<
  DisplayModeWrap,
  never,
  SqlClient.SqlClient | ServerSettings.ServerSettingsService | ProviderRegistry.ProviderRegistry
> = Layer.effect(
  DisplayModeWrap,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const subThreads = yield* SubThreads.orIdle;

    yield* createToldTable;

    yield* serverSettings.ready.pipe(
      Effect.andThen(pruneDeletedThreadModes()),
      Effect.andThen(sql`DELETE FROM fork_display_mode_told WHERE thread_id IN (
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL
      )`),
      Effect.catchCause((cause) => Effect.logWarning("Display mode prune skipped", { cause })),
      Effect.forkScoped,
    );

    // Reads newest first from before `before`, or from the end, until `coreCount` messages
    // (not rewrites) and, without `before`, a typed message, counted from `ownNativeId` back when
    // given, and with `toMainListMessage`, an event in the main list on its own. Visibility gets no
    // items: they only decide interrupt results, which never enter the agent's transcript.
    const shownItems = Effect.fn("DisplayModeWrap.shownItems")(function* (
      threadId: ThreadId,
      before: MessageId | null,
      ownNativeId?: string,
      coreCount: number = WRAPPED_CORE_COUNT,
      toMainListMessage = false,
    ) {
      const pageRows = Math.max(PAGE_ROWS, Math.min(coreCount, 64));
      let start = { ordinal: Number.MAX_SAFE_INTEGER, itemId: "" };
      if (before !== null) {
        const anchors = yield* sql<{ readonly turn_item_id: string; readonly ordinal: number }>`
          SELECT turn_item_id, ordinal FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND type = 'user_message'
            AND json_extract(payload_json, '$.messageId') = ${before}
          ORDER BY ordinal DESC LIMIT 1
        `;
        const anchor = anchors[0];
        if (anchor === undefined) return [];
        start = { ordinal: anchor.ordinal, itemId: anchor.turn_item_id };
      }
      let records = yield* projections.getThreadRecords(threadId, ["runs", "attempts"]);
      const segments: Segment[] = [
        {
          threadId,
          before: start,
          shows: createOrchestrationV2TurnItemVisibility({ ...records, items: [] }),
        },
      ];
      const seen = new Set<string>([threadId]);
      while (true) {
        const fork = ProjectionStore.inheritedRunFork(records.thread);
        if (fork === null || seen.has(fork.threadId)) break;
        seen.add(fork.threadId);
        const source = yield* projections.getThreadRecords(fork.threadId, ["runs", "attempts"]);
        const forkRun = source.runs.find((run) => run.id === fork.runId);
        if (forkRun === undefined) break;
        const runOrdinalById = new Map(source.runs.map((run) => [run.id, run.ordinal]));
        segments.push({
          threadId: fork.threadId,
          before: { ordinal: Number.MAX_SAFE_INTEGER, itemId: "" },
          shows: (item) =>
            ProjectionStore.isTurnItemAtOrBeforeRun({
              historyOrigin: source.thread.historyOrigin,
              itemRunId: item.runId,
              runOrdinalById,
              sourceRunOrdinal: forkRun.ordinal,
            }),
        });
        records = source;
      }

      // The screen shows only user messages and send_to_user calls, so the query steps over other rows.
      const shownOnly = sql`(item.type = 'user_message' OR ${sendCallSql(sql)})`;
      const found: OrchestrationV2TurnItem[] = [];
      let cores = 0;
      let passedTyped = before !== null;
      let passedOwn = ownNativeId === undefined;
      let passedMainList = !toMainListMessage;
      for (const segment of segments) {
        let { ordinal, itemId } = segment.before;
        while (true) {
          const rows = yield* sql<{
            readonly turn_item_id: string;
            readonly ordinal: number;
            readonly payload_json: string;
          }>`
            SELECT item.turn_item_id, item.ordinal, item.payload_json
            FROM orchestration_v2_projection_turn_items AS item
            WHERE item.thread_id = ${segment.threadId}
              AND item.ordinal <= ${ordinal} AND (item.ordinal < ${ordinal} OR item.turn_item_id < ${itemId})
              AND ${shownOnly}
            ORDER BY item.ordinal DESC, item.turn_item_id DESC
            LIMIT ${pageRows}
          `;
          for (const row of rows) {
            const item = yield* decodeTurnItem(row.payload_json);
            if (!segment.shows(item)) continue;
            found.push(item);
            if (item.nativeItemRef?.nativeId === ownNativeId) passedOwn = true;
            if (!passedOwn) continue;
            const event = displayEventFromTurnItem(item);
            if (event?.type === "user") passedTyped = true;
            if (event?.type === "user" || event?.type === "sent") cores++;
            if (event !== null && isMainListOnItsOwn(event)) passedMainList = true;
            if (passedTyped && passedMainList && cores >= coreCount) return found.reverse();
          }
          const last = rows.at(-1);
          if (last === undefined || rows.length < pageRows) break;
          ordinal = last.ordinal;
          itemId = last.turn_item_id;
        }
      }
      return found.reverse();
    });

    // The provider reads a slash command only at the start of the text.
    // A `<t3-messages-mode>` block before the command would break the command.
    // The known commands are `/compact` and `/goal`, which T3 Code reads from the text without the
    // provider's list, and the ones that the composer offers for the thread's provider and folder.
    const isSlashCommand = Effect.fn("DisplayModeWrap.isSlashCommand")(function* (
      threadId: ThreadId,
      message: { readonly text: string; readonly attachments?: ReadonlyArray<unknown> },
    ) {
      if (parseGoalCommand(message) !== null) return true;
      const name = /^\/(\S+)/.exec(message.text.trimStart())?.[1]?.toLowerCase();
      if (name === undefined) return false;
      const threads = yield* sql<{ readonly instance_id: string; readonly cwd: string | null }>`
        SELECT json_extract(t.payload_json, '$.modelSelection.instanceId') AS instance_id,
          COALESCE(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) AS cwd
        FROM orchestration_v2_projection_threads t
        LEFT JOIN projection_projects p ON p.project_id = t.project_id
        WHERE t.thread_id = ${threadId}
      `;
      const thread = threads[0];
      if (thread === undefined) return false;
      const provider = (yield* providerRegistry.getProviders).find(
        (candidate) => candidate.instanceId === thread.instance_id,
      );
      if (provider === undefined) return false;
      const commands =
        provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === thread.cwd)
          ?.slashCommands ?? provider.slashCommands;
      return commands.some((command) => command.name.toLowerCase() === name);
    });

    const recordTold = (threadId: ThreadId, mode: DisplayMode) =>
      sql`INSERT INTO fork_display_mode_told (thread_id, mode_id)
        VALUES (${threadId}, ${mode.toldId})
        ON CONFLICT (thread_id) DO UPDATE SET mode_id = excluded.mode_id`.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("Display mode note not recorded", { cause }),
        ),
      );

    const setTold = (threadId: ThreadId, modeId: string) =>
      sql`UPDATE fork_display_mode_told SET mode_id = ${modeId} WHERE thread_id = ${threadId}`;

    const forgetNotes: DisplayModeWrapShape["forgetNotes"] = Effect.fn(
      "DisplayModeWrap.forgetNotes",
    )(function* (threadId) {
      yield* setTold(threadId, UNKNOWN_TOLD).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Display mode notes not reset", { cause })),
      );
    });

    const changeContext = Effect.fn("DisplayModeWrap.changeContext")(function* (
      threadId: ThreadId,
      context: NoteContext,
    ) {
      if (context === "fresh") return yield* setTold(threadId, NORMAL_DISPLAY_MODE.toldId);
      if (context === "uncertain") return yield* setTold(threadId, UNKNOWN_TOLD);
      yield* sql`DELETE FROM fork_display_mode_told WHERE thread_id = ${threadId}`;
      yield* sql`INSERT INTO fork_display_mode_told (thread_id, mode_id)
        SELECT ${threadId}, ${UNKNOWN_TOLD} FROM fork_display_mode_told
        WHERE thread_id = ${context.copiedFrom}`;
    });

    const forgetNotesAfterCompaction: DisplayModeWrapShape["forgetNotesAfterCompaction"] =
      ({ threadId, runId, event }) =>
      (ingest) => {
        if (NOTE_AFTER_COMPACTION_DRIVERS.has(event.driver)) return ingest;
        if (
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed"
        ) {
          const item = event.turnItem;
          return Effect.gen(function* () {
            const before = yield* sql<{ readonly status: string }>`
              SELECT status FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${item.id}
            `.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Display mode compaction check skipped", { cause }).pipe(
                  Effect.as([{ status: "completed" }]),
                ),
              ),
            );
            const stored = yield* ingest;
            if (stored.length > 0 && before[0]?.status !== "completed")
              yield* forgetNotes(item.threadId);
            return stored;
          });
        }
        // A provider without compaction items, such as Cursor, reports a T3-started compaction
        // only as the end of the `/compact` run.
        if (event.type === "turn.terminal" && event.status === "completed" && runId !== undefined) {
          return Effect.tap(ingest, () =>
            sql<{ readonly payload_json: string }>`
              SELECT message.payload_json FROM orchestration_v2_projection_runs run
              JOIN orchestration_v2_projection_messages message
                ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
              WHERE run.run_id = ${runId}
            `.pipe(
              Effect.flatMap((rows) =>
                Effect.forEach(rows, (row) => decodePrompt(row.payload_json)),
              ),
              Effect.flatMap((prompts) =>
                prompts.some(isCompactionCommandMessage) ? forgetNotes(threadId) : Effect.void,
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("Display mode compaction check skipped", { cause }),
              ),
            ),
          );
        }
        return ingest;
      };

    const wrapUserText: DisplayModeWrapShape["wrapUserText"] = Effect.fn(
      "DisplayModeWrap.wrapUserText",
    )(function* ({ threadId, message, text, context }) {
      const unchanged: WrappedUserText = { text, accepted: Effect.void };
      return yield* Effect.gen(function* () {
        if (context !== undefined) yield* changeContext(threadId, context);
        // The note after a compaction covers a compaction command.
        if (
          !isWebTypedMessage(message) ||
          isCompactionCommandMessage({
            role: "user",
            text: message.text,
            attachments: message.attachments,
          })
        )
          return unchanged;
        const settings = yield* serverSettings.getSettings;
        const mode = resolveDisplayMode(settings.threadDisplayModes[threadId]);
        const toldRows = yield* sql<{ readonly mode_id: string }>`
          SELECT mode_id FROM fork_display_mode_told WHERE thread_id = ${threadId}
        `;
        const told = toldRows[0]?.mode_id ?? NORMAL_DISPLAY_MODE.toldId;
        // After `unknown` or an older rules version, the agent may not know the mode that a switch
        // notice would switch from, or its current rules.
        const note =
          told === mode.toldId
            ? null
            : DISPLAY_MODES.some((known) => known.toldId === told)
              ? mode.notice
              : mode.stateNotice;
        if (yield* isSlashCommand(threadId, message))
          return note === null
            ? unchanged
            : { ...unchanged, commandNote: { text: note, delivered: recordTold(threadId, mode) } };
        const under = mode.subThreads ? subThreadOfRecords(message.context?.records) : undefined;
        const events =
          mode.wrap === null || (mode.subThreads && under === undefined)
            ? []
            : (yield* shownItems(
                threadId,
                message.id,
                undefined,
                mode.subThreads ? SUB_THREAD_WINDOW_CORES : WRAPPED_CORE_COUNT,
              )).flatMap((item) => {
                const event = displayEventFromTurnItem(item);
                return event === null ? [] : [event];
              });
        const wrapped =
          mode.wrap === null ? text : mode.wrap(events, text, { id: message.id, under });
        if (under !== undefined) {
          yield* subThreads.changed({
            threadId,
            firstId: under,
            thread: [
              ...subThreadCores(foldCores(events), under),
              {
                id: message.id,
                from: "user" as const,
                text: message.text,
                first: under,
                reply: true,
              },
            ],
          });
        }
        return note === null
          ? { text: wrapped, accepted: Effect.void }
          : { text: `${note}\n${wrapped}`, accepted: recordTold(threadId, mode) };
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Display mode wrap skipped", {
            threadId,
            messageId: message.id,
            error,
          }).pipe(Effect.as(unchanged)),
        ),
      );
    });

    const latestShownItems: DisplayModeWrapShape["latestShownItems"] = Effect.fn(
      "DisplayModeWrap.latestShownItems",
    )((threadId, ownNativeId, cores, toMainListMessage) =>
      shownItems(threadId, null, ownNativeId, cores, toMainListMessage),
    );

    return DisplayModeWrap.of({
      wrapUserText,
      latestShownItems,
      forgetNotes,
      forgetNotesAfterCompaction,
    });
  }),
).pipe(Layer.provide(ProjectionStore.layer));

const unchanged = DisplayModeWrap.of({
  wrapUserText: Effect.fn("DisplayModeWrap.wrapUserTextUnchanged")(({ text }) =>
    Effect.succeed({ text, accepted: Effect.void }),
  ),
  latestShownItems: Effect.fn("DisplayModeWrap.latestShownItemsUnchanged")(() =>
    Effect.succeed([]),
  ),
  forgetNotes: Effect.fn("DisplayModeWrap.forgetNotesUnchanged")(() => Effect.void),
  forgetNotesAfterCompaction: () => (ingest) => ingest,
});

/** The provided wrapper. A runtime without one, such as a test of the calling service, sends text unchanged. */
export const orUnchanged = Effect.serviceOption(DisplayModeWrap).pipe(
  Effect.map(Option.getOrElse(() => unchanged)),
);

/**
 * Returns `session` with `wrapped.commandNote` in each turn it starts, and `wrapped.accepted` run after
 * each turn that the provider accepts.
 */
export const deliveringNote = <S extends ProviderAdapter.ProviderAdapterV2SessionRuntime>(
  session: S,
  wrapped: WrappedUserText,
): S => ({
  ...session,
  startTurn: (input: Parameters<S["startTurn"]>[0]) =>
    session
      .startTurn(
        wrapped.commandNote === undefined ? input : { ...input, commandNote: wrapped.commandNote },
      )
      .pipe(Effect.tap(() => wrapped.accepted)),
});
