import {
  CommandId,
  type ProviderApprovalPushHooks,
  type ProviderApprovalToolAction,
  RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpClientInput from "./McpClientInput.ts";
import type { Caller } from "./threadAccess.ts";

/**
 * How long one call waits for the person. Short of the tool-call limits of the provider clients
 * T3 Code does not configure, as the other waiting tools are; the request stays in the thread
 * after that, and the same call made again goes on waiting for it.
 */
export const ANSWER_WAIT = Duration.seconds(45);
const POLL_INTERVAL = Duration.millis(500);

/**
 * "waiting": the person has not answered yet, and the request is still theirs to answer.
 * "no-turn": the thread has no turn running, so there is nowhere to show a request.
 */
export type Answer =
  | "accepted"
  | "declined"
  | "unconfirmed"
  | "waiting"
  | "no-turn"
  | "unavailable";

type Threads = ThreadManagement.ThreadManagementService["Service"];
type Sessions = McpProviderSessions.McpProviderSessions["Service"];

/** A request as the thread's MCP session keeps it: `id` names its record there and its card. */
interface Raised {
  readonly threadId: ThreadId;
  readonly id: string;
}

const requestIdOf = (id: string) => RuntimeRequestId.make(`runtime-request:t3-tool:${id}`);

const readRequest = (threads: Threads, kept: Raised) =>
  threads.getThreadRecords(kept.threadId, ["runs", "runtimeRequests"]).pipe(
    Effect.map((records) => ({
      request: records.runtimeRequests.find((candidate) => candidate.id === requestIdOf(kept.id)),
      runs: records.runs,
    })),
  );

/**
 * A request outlives the call that raised it, so nothing else would close it when the agent
 * stops asking. It ends with the turn that asked, as a provider's own request does.
 */
const closeWithItsRun = Effect.fnUntraced(function* (
  threads: Threads,
  sessions: Sessions,
  kept: Raised,
  asked: { readonly runId: string; readonly nodeId: string },
) {
  while (true) {
    yield* Effect.sleep(POLL_INTERVAL);
    const { request, runs } = yield* readRequest(threads, kept);
    if (request?.status !== "pending") return;
    const run = runs.find((candidate) => candidate.id === asked.runId);
    if (
      run !== undefined &&
      !ThreadManagement.isTerminalRunStatus(run.status) &&
      run.rootNodeId === asked.nodeId
    )
      continue;
    yield* sessions.forgetApprovalRequest(kept.threadId, kept.id);
    yield* threads.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(`mcp:approval-request:${kept.id}:close`),
      threadId: kept.threadId,
      requestId: request.id,
      decision: "cancel",
    });
    return;
  }
});

/**
 * Asks the person in the calling thread itself, with a request the server raises and whose
 * answer it records, so it works whatever the thread's provider is. The request is kept with
 * the thread's MCP session under `state`: a call asking the same again finds it and its answer,
 * and reading an answer ends it, so one approval lets one call through.
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
  const { threads } = caller;

  const found = yield* sessions.findApprovalRequest(thread.threadId, input.message);
  let kept: Raised | undefined =
    found?.state === input.state ? { threadId: thread.threadId, id: found.id } : undefined;
  if (kept === undefined) {
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
    const id = yield* sessions.recordApprovalRequest(thread.threadId, input);
    const raised = { id, threadId: thread.threadId };
    const asked = { runId: run.id, nodeId: run.rootNodeId };
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
    yield* closeWithItsRun(threads, sessions, raised, asked).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkDetach,
    );
    kept = raised;
  }

  const waiting = kept;
  const answered = yield* Effect.gen(function* () {
    while (true) {
      const { request } = yield* readRequest(threads, waiting);
      if (request?.status !== "pending") return request;
      yield* Effect.sleep(POLL_INTERVAL);
    }
  }).pipe(
    Effect.timeoutOption(ANSWER_WAIT),
    Effect.catch((error) =>
      Effect.logWarning("Could not read an approval request", { error: error.message }).pipe(
        Effect.as(Option.none()),
      ),
    ),
  );
  if (Option.isNone(answered)) return "waiting";
  yield* sessions.forgetApprovalRequest(thread.threadId, waiting.id);
  const request = answered.value;
  // A request that ended without the person's answer, as one of an interrupted turn does.
  if (request?.status !== "resolved") return "unconfirmed";
  return request.decision === "accept" ? "accepted" : "declined";
});
