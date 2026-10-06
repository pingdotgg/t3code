/**
 * ClaudePluginUi — the latest UI that Claude Code plugins drew for each
 * Claude thread: `$.ui.status` lines, the last `$.ui.toast` and the
 * `AbovePrompt` band a plugin's `ui.render` hook returns.
 *
 * A headless Claude session pushes `system` messages (`ui_status`,
 * `ui_toast`, `ui_invalidate`) and draws a band only when asked with a
 * `ui_render` control request. The query runner hands every message to
 * `ingest` and registers the live query's control-request sender with
 * `attach`; this service asks for the band on attach and on each
 * invalidate, and clients subscribe to the per-thread snapshot.
 *
 * The protocol is internal to the Claude CLI. Any failure here is logged and
 * leaves the thread without plugin UI; it never affects a turn.
 */
import {
  CLAUDE_PLUGIN_UI_BAND_COLUMNS,
  type ClaudePluginUiElement,
  type ClaudePluginUiPressInput,
  type ClaudePluginUiSnapshot,
  EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** Sends one control request on the thread's live Claude query. */
export type ClaudeControlRequest = (request: Record<string, unknown>) => Promise<unknown>;

const BAND_INSTANCE_ID = "above-prompt";
const BAND_MAX_ROWS = 12;

interface ThreadEntry {
  request: ClaudeControlRequest | undefined;
  snapshot: ClaudePluginUiSnapshot;
  rendering: boolean;
  renderAgain: boolean;
}

export interface ClaudePluginUiShape {
  readonly attach: (threadId: ThreadId, request: ClaudeControlRequest) => Effect.Effect<void>;
  readonly detach: (threadId: ThreadId, request: ClaudeControlRequest) => Effect.Effect<void>;
  /** `from` is the sending query's control-request sender; messages from a replaced query are dropped. */
  readonly ingest: (
    threadId: ThreadId,
    message: unknown,
    from: ClaudeControlRequest | undefined,
  ) => Effect.Effect<void>;
  readonly subscribe: (threadId: ThreadId) => Stream.Stream<ClaudePluginUiSnapshot>;
  readonly press: (input: ClaudePluginUiPressInput) => Effect.Effect<void>;
}

export class ClaudePluginUi extends Context.Service<ClaudePluginUi, ClaudePluginUiShape>()(
  "t3/provider/ClaudePluginUi",
) {}

/** A plain object, not null or an array. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A band tree worth drawing: an element the plugins drew, not the engine's own
 * placeholder. The SDK resolves a control request with the whole
 * `{ subtype, request_id, response }` envelope.
 */
export const bandFromRenderResponse = (envelope: unknown): ClaudePluginUiElement | null => {
  const response = isRecord(envelope) ? envelope.response : undefined;
  if (!isRecord(response) || response.hooked !== true) return null;
  const tree = response.tree;
  if (!isRecord(tree) || typeof tree.type !== "string" || tree.type === "engine") return null;
  return tree as unknown as ClaudePluginUiElement;
};

/** Builds the service: per-thread plugin UI state, band renders, and subscriber signals. */
export const make = Effect.sync(() => {
  const threads = new Map<ThreadId, ThreadEntry>();
  let toastCount = 0;
  // Each subscriber's one-slot "changed" signal. A subscriber reads the current
  // snapshot when signalled, so a slow client holds one pending signal, never a
  // backlog of snapshots.
  const watchers = new Map<ThreadId, Set<Queue.Queue<void>>>();

  /** The thread's entry, created empty on first use. */
  const entryFor = (threadId: ThreadId): ThreadEntry => {
    let entry = threads.get(threadId);
    if (entry === undefined) {
      entry = {
        request: undefined,
        snapshot: EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT,
        rendering: false,
        renderAgain: false,
      };
      threads.set(threadId, entry);
    }
    return entry;
  };

  /** Applies `next` to the thread's snapshot and signals its subscribers when it changed. */
  const update = (
    threadId: ThreadId,
    next: (snapshot: ClaudePluginUiSnapshot) => ClaudePluginUiSnapshot,
  ) =>
    Effect.suspend(() => {
      const entry = entryFor(threadId);
      const snapshot = next(entry.snapshot);
      if (snapshot === entry.snapshot) return Effect.void;
      entry.snapshot = snapshot;
      return Effect.forEach(
        watchers.get(threadId) ?? [],
        (signal) => Queue.offer(signal, undefined),
        {
          discard: true,
        },
      );
    });

  /** Forgets a thread whose query has gone, once nothing is drawing for it. */
  const removeIfIdle = (threadId: ThreadId, entry: ThreadEntry) =>
    Effect.sync(() => {
      if (
        !entry.rendering &&
        entry.request === undefined &&
        entry.snapshot === EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT &&
        threads.get(threadId) === entry
      ) {
        threads.delete(threadId);
      }
    });

  /** Asks the CLI to draw the AbovePrompt band and stores the tree if this query is still current. */
  const renderBand = (threadId: ThreadId, request: ClaudeControlRequest) =>
    Effect.tryPromise(() =>
      request({
        subtype: "ui_render",
        surface: "desktop",
        component: "AbovePrompt",
        instance_id: BAND_INSTANCE_ID,
        props: {
          hasSurvey: false,
          isWorking: false,
          maxRows: BAND_MAX_ROWS,
          bodyColumns: CLAUDE_PLUGIN_UI_BAND_COLUMNS,
          scroll: { offset: 0, bodyRows: BAND_MAX_ROWS },
        },
      }),
    ).pipe(
      Effect.flatMap((response) =>
        // The query may have closed (or been replaced) while the render was in flight.
        threads.get(threadId)?.request === request
          ? update(threadId, (snapshot) => ({
              ...snapshot,
              band: bandFromRenderResponse(response),
            }))
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logDebug("claude-plugin-ui.render-failed", { threadId, cause }),
      ),
    );

  /** Asks for the band, folding invalidates that land while a render is in flight into one more. */
  const requestRender = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const entry = entryFor(threadId);
      if (entry.request === undefined) return Effect.void;
      if (entry.rendering) {
        entry.renderAgain = true;
        return Effect.void;
      }
      entry.rendering = true;
      const loop: Effect.Effect<void> = Effect.suspend(() => {
        const request = entry.request;
        entry.renderAgain = false;
        if (request === undefined) return Effect.void;
        return renderBand(threadId, request).pipe(
          Effect.andThen(Effect.suspend(() => (entry.renderAgain ? loop : Effect.void))),
        );
      });
      return loop.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.rendering = false;
          }).pipe(Effect.andThen(removeIfIdle(threadId, entry))),
        ),
        Effect.forkDetach,
        Effect.asVoid,
      );
    });

  /** Registers a thread's live query and asks it for the band. */
  const attach: ClaudePluginUiShape["attach"] = (threadId, request) =>
    Effect.suspend(() => {
      entryFor(threadId).request = request;
      return requestRender(threadId);
    });

  /** Clears a thread's plugin UI when the query that attached it closes. */
  const detach: ClaudePluginUiShape["detach"] = (threadId, request) =>
    Effect.suspend(() => {
      const entry = threads.get(threadId);
      // A replacement query may already have attached; only its own close clears it.
      if (entry === undefined || entry.request !== request) return Effect.void;
      entry.request = undefined;
      return update(threadId, () => EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT).pipe(
        Effect.andThen(removeIfIdle(threadId, entry)),
      );
    });

  /** Applies one `ui_status`, `ui_toast` or `ui_invalidate` message from the current query. */
  const ingest: ClaudePluginUiShape["ingest"] = (threadId, message, from) => {
    if (!isRecord(message) || message.type !== "system") return Effect.void;
    // A late message from a replaced query must not draw over the current one.
    if (threads.get(threadId)?.request !== from) return Effect.void;
    switch (message.subtype) {
      case "ui_status": {
        if (typeof message.plugin !== "string") return Effect.void;
        const plugin = message.plugin;
        const text = typeof message.text === "string" && message.text !== "" ? message.text : null;
        return update(threadId, (snapshot) => {
          const others = snapshot.statuses.filter((status) => status.plugin !== plugin);
          if (text === null && others.length === snapshot.statuses.length) return snapshot;
          return {
            ...snapshot,
            statuses: text === null ? others : [...others, { plugin, text }],
          };
        });
      }
      case "ui_toast": {
        if (typeof message.plugin !== "string" || typeof message.text !== "string") {
          return Effect.void;
        }
        const toast = {
          id: typeof message.uuid === "string" ? message.uuid : `toast-${++toastCount}`,
          plugin: message.plugin,
          text: message.text,
          timeoutMs: typeof message.timeout_ms === "number" ? message.timeout_ms : 4000,
        };
        return update(threadId, (snapshot) => ({ ...snapshot, toast }));
      }
      case "ui_invalidate":
        return requestRender(threadId);
      default:
        return Effect.void;
    }
  };

  /** The thread's current snapshot, then the latest one after each change. */
  const subscribe: ClaudePluginUiShape["subscribe"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const signal = yield* Queue.sliding<void>(1);
        let signals = watchers.get(threadId);
        if (signals === undefined) {
          signals = new Set();
          watchers.set(threadId, signals);
        }
        const own = signals;
        own.add(signal);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            own.delete(signal);
            if (own.size === 0 && watchers.get(threadId) === own) watchers.delete(threadId);
          }),
        );
        const current = () => threads.get(threadId)?.snapshot ?? EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT;
        return Stream.concat(
          Stream.make(current()),
          Stream.fromQueue(signal).pipe(Stream.map(() => current())),
        );
      }),
    );

  /** Forwards a plugin Button press to the thread's live query. */
  const press: ClaudePluginUiShape["press"] = (input) =>
    Effect.suspend(() => {
      const request = threads.get(input.threadId)?.request;
      if (request === undefined) return Effect.void;
      return Effect.tryPromise(() =>
        request({
          subtype: "ui_press",
          plugin: input.plugin,
          handle: input.handle,
          surface: "desktop",
          ...(input.key === undefined ? {} : { key: input.key }),
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("claude-plugin-ui.press-failed", { threadId: input.threadId, cause }),
        ),
        Effect.asVoid,
      );
    });

  return ClaudePluginUi.of({ attach, detach, ingest, subscribe, press });
});

/** Provides the shared ClaudePluginUi service. */
export const layer = Layer.effect(ClaudePluginUi, make);
