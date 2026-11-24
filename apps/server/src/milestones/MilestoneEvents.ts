import {
  AuthSessionId,
  type MilestoneEvent as MilestoneEventValue,
  MilestoneEvent,
  type MilestoneFilter,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, type McpServer } from "effect/ai";

import * as SessionStore from "../auth/SessionStore.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
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

/**
 * Each milestone type as an MCP event type (SEP-3415), for outside clients to poll, stream or
 * receive by webhook. Cursors are the hub's, so a client that was away catches up on what the
 * hub still keeps. Workflow runs have no project or thread, so their types are narrowed by
 * workflow and run.
 */
export const make = Effect.gen(function* () {
  const hub = yield* MilestoneHub.MilestoneHub;
  const sessions = yield* Effect.serviceOption(SessionStore.SessionStore);
  // A webhook subscription outlives its request, so it ends itself when the client's session does.
  const untilRevoked = Effect.fnUntraced(function* <A>(items: Stream.Stream<A>) {
    const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
    const sessionId = Option.getOrUndefined(scope)?.client?.sessionId;
    if (sessionId === undefined || Option.isNone(sessions)) return items;
    const revoked = sessions.value.awaitInvalidation(AuthSessionId.make(sessionId)).pipe(
      Effect.ignore,
      Effect.andThen(
        Effect.fail(
          new McpSchema.Forbidden({
            message: "Access revoked",
            data: { reason: "Access revoked" },
          }),
        ),
      ),
    );
    return items.pipe(Stream.interruptWhen(revoked));
  });
  const digest = yield* Effect.service(Digest.Digest).pipe(Effect.provide(Digest.layerWebCrypto));
  // TODO(#41158): drop this bridge for clients predating SEP-3415 (ChatGPT, @ai-sdk/mcp).
  // They take an event's eventId as its webhook-id, which allows only [A-Za-z0-9_-], so the
  // eventId is a hash of the milestone id, the same in every delivery mode.
  const occurrence = ({ event }: MilestoneHub.PositionedMilestone) =>
    Effect.map(digest.digest(Digest.sha256, new TextEncoder().encode(event.id)), (hash) => ({
      eventId: `evt_${Base64Url.encode(hash).slice(0, 22)}`,
      timestamp: event.occurredAt,
      data: event,
    }));
  const context = { hub, untilRevoked, occurrence };
  const isWorkflow = (payload: (typeof MilestoneEvent.members)[number]) =>
    payload.fields.type.literal.startsWith("workflow.");
  return {
    threads: MilestoneEvent.members
      .filter((payload) => !isWorkflow(payload))
      .map((payload) => eventOf(context, payload, Parameters)),
    workflows: MilestoneEvent.members
      .filter(isWorkflow)
      .map((payload) => eventOf(context, payload, WorkflowParameters)),
  };
});

const eventOf = <P extends typeof Parameters | typeof WorkflowParameters>(
  {
    hub,
    untilRevoked,
    occurrence,
  }: {
    readonly hub: MilestoneHub.MilestoneHub["Service"];
    readonly occurrence: (milestone: MilestoneHub.PositionedMilestone) => Effect.Effect<{
      readonly eventId: string;
      readonly timestamp: string;
      readonly data: MilestoneEventValue;
    }>;
    readonly untilRevoked: <A>(
      items: Stream.Stream<A>,
    ) => Effect.Effect<Stream.Stream<A, McpSchema.Forbidden>>;
  },
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
        .pipe(
          Effect.flatMap((page) =>
            Effect.map(Effect.forEach(page.events, occurrence), (events) => ({
              ...page,
              events,
            })),
          ),
        ),
    stream: Effect.fn("MilestoneEvents.stream")(function* (
      args: P["Type"],
      request: McpServer.EventStreamRequest,
    ) {
      const { cursor, truncated, items } = yield* hub.follow({
        cursor: request.cursor,
        maxAgeMs: request.maxAgeMs,
        filter: filterOf(args),
      });
      return {
        cursor,
        truncated,
        items: yield* untilRevoked(
          items.pipe(
            Stream.mapEffect(
              (item): Effect.Effect<McpServer.EventStreamItem<MilestoneEventValue>> =>
                item._tag === "Milestone"
                  ? Effect.map(occurrence(item), (event) => ({
                      _tag: "Event" as const,
                      cursor: item.cursor,
                      ...event,
                    }))
                  : Effect.succeed(item),
            ),
          ),
        ),
      };
    }),
  } satisfies McpServer.EventOptions<P, typeof payload, never>;
};
