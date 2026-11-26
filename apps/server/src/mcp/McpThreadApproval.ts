import {
  CommandId,
  type NodeId,
  type OrchestrationV2RuntimeRequest,
  type ProviderApprovalPushHooks,
  type ProviderApprovalToolAction,
  type RunId,
  RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpClientInput from "./McpClientInput.ts";
import * as McpToolDeadline from "./McpToolDeadline.ts";
import type { Caller } from "./threadAccess.ts";

/**
 * How long a call waits for the person when its client holds nothing open for it. Such a
 * client has a tool-call limit of its own that T3 Code cannot stop, so the call ends before
 * that with "waiting". The request is not timed: it stays, and the same call made again
 * goes on waiting for it.
 */
export const UNHELD_WAIT = Duration.seconds(45);

/**
 * "cancelled": ended without the person's answer (dismissed, or its turn ended). "no-turn": no
 * turn is running to show a request in. "waiting": not answered yet, and still theirs to answer.
 * "full": the thread already has as many requests waiting for the person as it keeps.
 */
export type Answer = McpProviderSessions.T3ApprovalAnswer | "no-turn" | "waiting" | "full";

type Threads = ThreadManagement.ThreadManagementService["Service"];
type Sessions = McpProviderSessions.McpProviderSessions["Service"];

/** A request as the thread's MCP session keeps it: `id` names its record there and its card. */
interface Raised {
  readonly threadId: ThreadId;
  readonly id: string;
}

interface Turn {
  readonly runId: RunId;
  readonly nodeId: NodeId;
}

const requestIdOf = (id: string) => RuntimeRequestId.make(`runtime-request:t3-tool:${id}`);

const answerOf = (
  request: OrchestrationV2RuntimeRequest | undefined,
): McpProviderSessions.T3ApprovalAnswer =>
  request?.status !== "resolved"
    ? "cancelled"
    : request.decision === "accept"
      ? "accepted"
      : request.decision === "decline"
        ? "declined"
        : "cancelled";

/** Ends a request nobody answered, so no card is left for something nothing waits on. */
const close = (threads: Threads, kept: Raised, decision: "cancel" | "decline") =>
  threads
    .dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(`mcp:approval-request:${kept.id}:close`),
      threadId: kept.threadId,
      requestId: requestIdOf(kept.id),
      decision,
    })
    .pipe(Effect.ignoreCause({ log: true }));

/**
 * Follows one request to its end and settles it for whoever waits on it. Nothing here is
 * timed. The request is tied to the turn that asked: that turn ending or being interrupted
 * cancels it, and archiving the thread declines it. A client of the app going away does not.
 */
const follow = Effect.fnUntraced(function* (
  threads: Threads,
  sessions: Sessions,
  kept: Raised,
  asked: Turn,
) {
  const read = Effect.gen(function* () {
    const records = yield* threads.getThreadRecords(kept.threadId, ["runs", "runtimeRequests"]);
    const request = records.runtimeRequests.find(
      (candidate) => candidate.id === requestIdOf(kept.id),
    );
    if (request?.status !== "pending") return Option.some(answerOf(request));
    const run = records.runs.find((candidate) => candidate.id === asked.runId);
    if (
      run === undefined ||
      ThreadManagement.isTerminalRunStatus(run.status) ||
      run.rootNodeId !== asked.nodeId
    ) {
      yield* close(threads, kept, "cancel");
      return Option.some("cancelled" as const);
    }
    const shell = yield* threads.getThreadShell(kept.threadId);
    if (shell === null || shell.archivedAt !== null) {
      yield* close(threads, kept, "decline");
      return Option.some("declined" as const);
    }
    return Option.none();
  });
  // Taken before the first read, so a change between that read and the subscription replays.
  const afterSequence = yield* threads.getThreadEventSequence(kept.threadId);
  const changes = Stream.mergeAll(
    (["runtime-request.updated", "run.updated", "thread.archived"] as const).map((eventType) =>
      threads.streamStoredEventsFrom({ threadId: kept.threadId, afterSequence, eventType }),
    ),
    { concurrency: "unbounded" },
  );
  const ended = yield* Stream.concat(
    Stream.fromEffect(read),
    Stream.mapEffect(changes, () => read),
  ).pipe(Stream.filter(Option.isSome), Stream.runHead);
  return Option.getOrElse(Option.flatten(ended), () => "cancelled" as const);
});

const followToItsEnd = (threads: Threads, sessions: Sessions, kept: Raised, asked: Turn) =>
  follow(threads, sessions, kept, asked).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not follow an approval request", { cause }).pipe(
        Effect.andThen(close(threads, kept, "cancel")),
        Effect.as("cancelled" as const),
      ),
    ),
    Effect.flatMap((answer) => sessions.settleApprovalRequest(kept.threadId, kept.id, answer)),
  );

/**
 * Asks the person in `thread` by a request the server raises and records the answer to. A client
 * that holds an elicitation for it waits as long as they take; any other hears "waiting" after
 * `UNHELD_WAIT`. One approval lets one call through: of calls waiting on one request, the rest ask again.
 */
export const ask = Effect.fn("McpThreadApproval.ask")(function* (
  threads: Threads,
  sessions: Sessions,
  thread: NonNullable<Caller["scope"]["thread"]>,
  input: {
    readonly state: string;
    readonly message: string;
    readonly toolAction: ProviderApprovalToolAction;
    readonly pushHooks?: ProviderApprovalPushHooks | undefined;
  },
): Effect.fn.Return<Answer> {
  while (true) {
    // A request needs a turn to be shown in and to end with.
    const records = yield* threads
      .getThreadRecords(thread.threadId, ["runs"])
      .pipe(Effect.orElseSucceed(() => undefined));
    const run = records === undefined ? undefined : ThreadManagement.latestActiveRun(records);
    if (
      run === undefined ||
      run.rootNodeId === null ||
      run.providerInstanceId !== thread.providerInstanceId
    ) {
      return "no-turn";
    }
    const asked: Turn = { runId: run.id, nodeId: run.rootNodeId };

    const joined = yield* sessions.joinApprovalRequest(thread.threadId, {
      message: input.message,
      state: `${asked.runId} ${input.state}`,
    });
    if (joined === undefined) return "full";
    const kept: Raised = { id: joined.id, threadId: thread.threadId };
    if (joined.opened) {
      const shown = yield* threads
        .dispatch({
          type: "approval_request.record",
          commandId: CommandId.make(`mcp:approval-request:${kept.id}`),
          threadId: thread.threadId,
          ...asked,
          requestId: requestIdOf(kept.id),
          prompt: input.message,
          toolAction: input.toolAction,
          ...(input.pushHooks === undefined ? {} : { pushHooks: input.pushHooks }),
        })
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Could not show an approval request in its thread", {
              error: error.message,
            }).pipe(Effect.as(false)),
          ),
        );
      if (!shown) {
        // The orchestrator refuses a request for a turn that ended since it was read.
        yield* sessions.forgetApprovalRequest(thread.threadId, kept.id);
        return "no-turn";
      }
      yield* followToItsEnd(threads, sessions, kept, asked).pipe(Effect.forkDetach);
    }

    type Outcome = Option.Option<McpProviderSessions.T3ApprovalAnswer>;
    // Once the client holds nothing open, as after it answers for itself or its turn is
    // interrupted, the call can only wait as long as that client's own limit allows.
    const unheld: Effect.Effect<Outcome> = Effect.timeoutOption(joined.answer, UNHELD_WAIT);
    // Only an adapter that holds T3 Code's requests is sent one: any other would show or answer it.
    const held =
      (yield* sessions.areApprovalRequestsHeld(thread.providerInstanceId)) &&
      (yield* McpClientInput.takesElicitation);
    // Read before the client is asked again: the call that brings a reply finds the answer here.
    const already = yield* joined.answered;
    const outcome: Outcome = Option.isSome(already)
      ? already
      : yield* McpToolDeadline.whileWaitingOnPerson(
          Effect.raceFirst(
            Effect.asSome(joined.answer),
            held
              ? McpClientInput.elicit({ id: kept.id, message: input.message }).pipe(
                  // A sessionless client got the elicitation as this call's answer, and the
                  // request stays for the call that follows it.
                  Effect.flatMap((sent) => (sent === "asked" ? Effect.succeedNone : unheld)),
                )
              : unheld,
          ),
        );
    if (Option.isNone(outcome)) return "waiting";
    const taken = yield* sessions.forgetApprovalRequest(thread.threadId, kept.id);
    // An approval is used once. Another call waiting on this request took it, so this one asks.
    if (outcome.value === "accepted" && !taken) continue;
    return outcome.value;
  }
});
