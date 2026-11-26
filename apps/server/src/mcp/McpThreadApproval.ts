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
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpClientInput from "./McpClientInput.ts";
import type { Caller } from "./threadAccess.ts";

/**
 * "cancelled": the request ended without the person's answer, as when its turn ends or is
 * interrupted, or they dismiss it. "no-turn": the thread has no turn running, so there is
 * nowhere to show a request. "unavailable": this thread's client cannot be left waiting on one.
 */
export type Answer = McpProviderSessions.T3ApprovalAnswer | "no-turn" | "unavailable";

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
 * Asks the person in the calling thread by a request the server raises and records the answer
 * to, then waits for that answer with no limit of its own. The client is sent the request as an
 * elicitation only so that it lets the call wait. One approval lets one call through: the call
 * that asked, or the same call made again in the same turn.
 */
export const ask = Effect.fn("McpThreadApproval.ask")(function* (
  caller: Caller,
  input: {
    readonly state: string;
    readonly message: string;
    readonly toolAction: ProviderApprovalToolAction;
    readonly pushHooks?: ProviderApprovalPushHooks | undefined;
  },
): Effect.fn.Return<Answer> {
  const sessions = Option.getOrUndefined(
    yield* Effect.serviceOption(McpClientInput.McpClientInput),
  )?.sessions;
  const thread = caller.scope.thread;
  if (sessions === undefined || thread === undefined) return "unavailable";
  if (
    !(yield* sessions.areApprovalRequestsHeld(thread.providerInstanceId)) ||
    !(yield* McpClientInput.takesElicitation)
  ) {
    return "unavailable";
  }
  const { threads } = caller;

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
  const state = `${asked.runId} ${input.state}`;

  const found = yield* sessions.findApprovalRequest(thread.threadId, state);
  let kept: Raised | undefined =
    found === undefined ? undefined : { threadId: thread.threadId, id: found.id };
  if (kept === undefined) {
    const id = yield* sessions.recordApprovalRequest(thread.threadId, {
      message: input.message,
      state,
    });
    const raised = { id, threadId: thread.threadId };
    const shown = yield* threads
      .dispatch({
        type: "approval_request.record",
        commandId: CommandId.make(`mcp:approval-request:${id}`),
        threadId: thread.threadId,
        ...asked,
        requestId: requestIdOf(id),
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
      yield* sessions.forgetApprovalRequest(thread.threadId, id);
      return "no-turn";
    }
    yield* followToItsEnd(threads, sessions, raised, asked).pipe(Effect.forkDetach);
    kept = raised;
  }

  const waiting = kept;
  const answered = sessions.awaitApprovalAnswer(thread.threadId, waiting.id);
  const held = McpClientInput.elicit({ id: waiting.id, message: input.message });
  const answer = yield* Effect.raceFirst(
    Effect.asSome(answered),
    // The adapter replies once the request has ended, so a reply may arrive with the answer.
    Effect.andThen(held, sessions.approvalAnswer(thread.threadId, waiting.id)),
  );
  if (Option.isNone(answer)) {
    // The client stopped waiting before the person answered, as it does when its turn is
    // interrupted. Nothing holds this call open now, so the request ends with it.
    yield* close(threads, waiting, "cancel");
    yield* sessions.forgetApprovalRequest(thread.threadId, waiting.id);
    return "cancelled";
  }
  yield* sessions.forgetApprovalRequest(thread.threadId, waiting.id);
  return answer.value;
});
