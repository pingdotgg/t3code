import {
  type MilestoneEvent as MilestoneEventValue,
  MilestoneEvent,
  type MilestoneFilter,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { McpServer } from "effect/ai";

import * as MilestoneHub from "./MilestoneHub.ts";

// Matches the hub's buffer, so a poll can drain everything it keeps at once.
const MAX_EVENTS = 1_000;
const DEFAULT_EVENTS = 100;

const includeSubagentChildren = Schema.optional(
  Schema.Boolean.annotate({
    description: "Also subagent threads and runs another run invoked.",
  }),
);
const workflowRunIds = Schema.optional(Schema.Array(TrimmedNonEmptyString));

const Parameters = Schema.Struct({
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  threadIds: Schema.optional(Schema.Array(ThreadId)),
  workflowRunIds: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).annotate({
      description: "Workflow runs, for the threads that are their agent steps.",
    }),
  ),
  includeSubagentChildren,
});

const WorkflowParameters = Schema.Struct({
  workflows: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).annotate({ description: "Workflow names." }),
  ),
  workflowRunIds,
  includeSubagentChildren,
});

const DESCRIPTIONS: Record<MilestoneEventValue["type"], string> = {
  "thread.run_settled": "A thread's turn ended: completed, failed, interrupted or cancelled.",
  "thread.needs_input": "An agent waits on a person to answer a question or approve an action.",
  "thread.input_resolved": "A question or approval an agent waited on was answered, or lapsed.",
  "thread.guest_request": "A guest on a shared thread asked for something.",
  "thread.guest_request_resolved": "A guest's request was sent, dismissed, or its link closed.",
  "pr.watch_wake": "A watched pull request changed and woke its thread.",
  "workflow.run_started": "A workflow run started.",
  "workflow.needs_input": "A workflow run asks a person a question.",
  "workflow.input_resolved":
    "A workflow run's question was answered, timed out, or ended with its run.",
  "workflow.run_paused": "A workflow run paused: a step failed, or someone paused it.",
  "workflow.run_resumed": "A paused workflow run went on again.",
  "workflow.run_ended": "A workflow run ended: completed, stopped, skipped or cancelled.",
};

const occurrence = ({ event }: MilestoneHub.PositionedMilestone) => ({
  eventId: event.id,
  timestamp: event.occurredAt,
  data: event,
});

/**
 * Each milestone type as an MCP event type (SEP-3415), for outside clients to poll or stream.
 * Cursors are the hub's, so a client that was away catches up on what the hub still keeps.
 * Workflow runs have no project or thread, so their types are narrowed by workflow and run.
 */
export const make = Effect.gen(function* () {
  const hub = yield* MilestoneHub.MilestoneHub;
  const isWorkflow = (payload: (typeof MilestoneEvent.members)[number]) =>
    payload.fields.type.literal.startsWith("workflow.");
  return {
    threads: MilestoneEvent.members
      .filter((payload) => !isWorkflow(payload))
      .map((payload) => eventOf(hub, payload, Parameters)),
    workflows: MilestoneEvent.members
      .filter(isWorkflow)
      .map((payload) => eventOf(hub, payload, WorkflowParameters)),
  };
});

const eventOf = <P extends typeof Parameters | typeof WorkflowParameters>(
  hub: MilestoneHub.MilestoneHub["Service"],
  payload: (typeof MilestoneEvent.members)[number],
  parameters: P,
) => {
  const type = payload.fields.type.literal;
  const filterOf = (args: P["Type"]): MilestoneFilter => ({ ...args, types: [type] });
  return {
    name: type,
    description: DESCRIPTIONS[type],
    parameters,
    payload,
    poll: (args, request) =>
      hub
        .read({
          cursor: request.cursor,
          maxAgeMs: request.maxAgeMs,
          filter: filterOf(args),
          limit: Math.min(request.maxEvents ?? DEFAULT_EVENTS, MAX_EVENTS),
        })
        .pipe(Effect.map((page) => ({ ...page, events: page.events.map(occurrence) }))),
    stream: (args, request) =>
      hub
        .follow({ cursor: request.cursor, maxAgeMs: request.maxAgeMs, filter: filterOf(args) })
        .pipe(
          Effect.map(({ cursor, truncated, items }) => ({
            cursor,
            truncated,
            items: items.pipe(
              Stream.map((item): McpServer.EventStreamItem<MilestoneEventValue> =>
                item._tag === "Milestone"
                  ? { _tag: "Event", cursor: item.cursor, ...occurrence(item) }
                  : item,
              ),
            ),
          })),
        ),
  } satisfies McpServer.EventOptions<P, typeof payload, never>;
};
