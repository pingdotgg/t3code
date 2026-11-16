import { DASHBOARD_SLOT_TITLES, DashboardSlotId, OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  DASHBOARD_GET_TOOL_NAME,
  DASHBOARD_SET_TOOL_NAME,
  threadDisplay,
} from "@t3tools/shared/displayModes";
import { TEXT_MATCH_MIN_RATIO } from "@t3tools/shared/textMatch";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ThreadDashboard } from "./ThreadDashboard.ts";
import { DASHBOARD_SLOT_LIMIT, visibleUnits } from "./visibleUnits.ts";

const ONLY_WITH_DASHBOARD = "Only in threads whose Dashboard is on; refused elsewhere.";

// Both texts travel in one tool input, which loses its text on the wire over 16 KiB of JSON.
const SLOT_TEXT_MAX_BYTES = 6_000;

// The description goes before the checks: one set after a custom check is left out of the JSON schema.
const slotText = (description: string) =>
  Schema.String.annotate({ description }).check(
    Schema.isMaxLength(SLOT_TEXT_MAX_BYTES),
    Schema.makeFilter((text: string) =>
      Buffer.byteLength(JSON.stringify(text), "utf8") - 2 <= SLOT_TEXT_MAX_BYTES
        ? true
        : `The text is over ${SLOT_TEXT_MAX_BYTES} bytes of UTF-8 once JSON-escaped. Shorten it.`,
    ),
  );

const DashboardSetTool = Tool.make(DASHBOARD_SET_TOOL_NAME, {
  description: `${ONLY_WITH_DASHBOARD} Replace one whole slot of this thread's Dashboard, which the user sees beside the chat. Refused when old_text no longer matches the slot.`,
  parameters: Schema.Struct({
    slot: DashboardSlotId.annotate({
      description:
        "decide: needs the user's decision. waiting: waits on something outside. working: in progress. autoreview: under automatic review. humanreview: waits for the user's review. merged: recently merged.",
    }),
    old_text: slotText(
      `The slot's current text as dashboard_get returns it, empty for an empty slot. Refused with the current text unless at least ${Math.round(TEXT_MATCH_MIN_RATIO * 100)}% alike.`,
    ),
    new_text: slotText(
      `The whole new text, in markdown. Empty text clears the slot. At most ${DASHBOARD_SLOT_LIMIT} visible units: a CJK full-width character counts 3, any other letter or digit 1; whitespace, punctuation, symbols, URLs, HTML tags and numbered-list markers count 0.`,
    ),
  }),
  success: Schema.Struct({ ok: Schema.Literal(true), message: Schema.String }),
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ServerSettings.ServerSettingsService,
    ThreadDashboard,
  ],
})
  .annotate(Tool.Title, "Update the Dashboard")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const DashboardGetTool = Tool.make(DASHBOARD_GET_TOOL_NAME, {
  description: `${ONLY_WITH_DASHBOARD} Read this thread's Dashboard: each slot in page order with its text and when it was last written.`,
  success: Schema.Struct({
    slots: Schema.Array(
      Schema.Struct({
        slot: DashboardSlotId,
        title: Schema.String,
        text: Schema.String,
        updatedAt: Schema.NullOr(Schema.String),
        age: Schema.NullOr(Schema.String),
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ServerSettings.ServerSettingsService,
    ThreadDashboard,
  ],
})
  .annotate(Tool.Title, "Read the Dashboard")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DashboardToolkit = Toolkit.make(DashboardSetTool, DashboardGetTool);

/** The caller's thread, refused unless its Dashboard is on. */
const dashboardThread = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "The Dashboard");
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
    ),
  );
  if (!threadDisplay(settings, thread.threadId).dashboard) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "This thread's Dashboard is off. The user can turn it on with Enable Dashboard in the thread menu.",
    });
  }
  return thread.threadId;
});

function age(updatedAt: string, now: DateTime.Utc): string {
  const minutes = Math.round((DateTime.toEpochMillis(now) - Date.parse(updatedAt)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

// The Dashboard changes only what the caller's thread shows, so read-only sandboxes and plan mode may use it.
export const layerHandlers = McpToolAccess.toLayer(DashboardToolkit, {
  [DASHBOARD_SET_TOOL_NAME]: McpToolAccess.readsAsCaller(({ slot, old_text, new_text }) =>
    Effect.gen(function* () {
      const threadId = yield* dashboardThread;
      const units = visibleUnits(new_text);
      if (units > DASHBOARD_SLOT_LIMIT) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Refused: ${slot} has ${units} visible units, limit ${DASHBOARD_SLOT_LIMIT}`,
        });
      }
      yield* (yield* ThreadDashboard).set(threadId, slot, old_text, new_text).pipe(
        Effect.catchTags({
          DashboardTextMismatch: (mismatch) =>
            Effect.fail(
              new OrchestratorMcpFailure({
                code: "invalid_request",
                message: `Refused: old_text does not match the current ${slot} text (${Math.floor(mismatch.similarity * 100)}% alike, at least ${Math.round(TEXT_MATCH_MIN_RATIO * 100)}% needed). Current text:\n${mismatch.current === "" ? "(empty)" : mismatch.current}`,
              }),
            ),
        }),
      );
      return {
        ok: true as const,
        message: `Written: ${slot} ${units}/${DASHBOARD_SLOT_LIMIT} visible units`,
      };
    }),
  ),
  [DASHBOARD_GET_TOOL_NAME]: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const threadId = yield* dashboardThread;
      const dashboard = yield* (yield* ThreadDashboard).read(threadId);
      const now = yield* DateTime.now;
      return {
        slots: dashboard.slots.map((entry) => ({
          slot: entry.slot,
          title: DASHBOARD_SLOT_TITLES[entry.slot],
          text: entry.text,
          updatedAt: entry.updatedAt,
          age: entry.updatedAt === null ? null : age(entry.updatedAt, now),
        })),
      };
    }),
  ),
});
