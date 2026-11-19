// Agent steps in a linked environment: the same three operations, as that environment's T3 tools.
import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import type * as Schema from "effect/Schema";

import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import {
  type AgentResult,
  type AgentTurn,
  isProjectPath,
  WorkflowAgentError,
  type WorkflowAgents,
} from "./WorkflowAgents.ts";

// A run acts for whoever owns this environment, not for an agent with modes of its own, so the
// only ceiling on what it starts there is the access the link was paired with.
const LIMITS = { runtimeMode: "full-access", interactionMode: "default" } as const;

// T3 Connect's edge drops a request that is idle for about 100 s, so a wait goes out in pieces.
const WAIT_PIECE = Duration.seconds(50);

/** The link is gone or the thread is: asking again cannot help. */
const isFinal = (error: OrchestratorMcpFailure) =>
  error.code === "capability_denied" ||
  error.code === "thread_not_found" ||
  error.code === "run_not_found" ||
  error.code === "invalid_request";

// The other machine asleep or a dropped route is worth a few more tries before the run pauses.
const retried = { schedule: Schedule.exponential("2 seconds"), times: 5 };

type Service = WorkflowAgents["Service"];

export const make = Effect.gen(function* () {
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const links = yield* PeerLinks.PeerLinks;

  const call = <S extends Schema.Decoder<unknown>>(
    environment: string,
    tool: string,
    success: S,
    args: Record<string, unknown>,
  ) =>
    peers
      .call({
        environmentId: environment as EnvironmentId,
        tool,
        arguments: args,
        limits: LIMITS,
        success,
      })
      .pipe(
        Effect.retry({ ...retried, while: (error) => !isFinal(error) }),
        Effect.mapError(
          (error) =>
            new WorkflowAgentError({
              reason: `Environment ${environment} refused ${tool}: ${error.message}`,
            }),
        ),
      );

  const listed = Effect.fn("WorkflowAgentLinks.listed")(function* (
    environment: string,
    path: string,
  ) {
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page: Schema.Schema.Type<typeof ProjectToolkit.tools.t3_project_list.successSchema> =
        yield* call(
          environment,
          "t3_project_list",
          ProjectToolkit.tools.t3_project_list.successSchema,
          { cursor, limit: 100 },
        );
      const found = page.projects.find((project) => project.workspaceRoot === path);
      if (found !== undefined) return found.id;
      cursor = page.nextCursor;
    }
    return undefined;
  });

  /**
   * The project at a folder there. A machine made for one run has the folder and no project yet,
   * so a folder that is not one is registered. Two steps may do that at once; the one that is
   * refused finds the other's.
   */
  const projectAt = Effect.fn("WorkflowAgentLinks.projectAt")(function* (
    environment: string,
    path: string,
  ) {
    const known = yield* listed(environment, path);
    if (known !== undefined) return known;
    const title = path.split("/").findLast((part) => part.length > 0) ?? path;
    const created = yield* call(
      environment,
      "t3_project_create",
      ProjectToolkit.tools.t3_project_create.successSchema,
      { title, workspaceRoot: path },
    ).pipe(Effect.result);
    if (Result.isSuccess(created)) return created.success.id;
    return (yield* listed(environment, path)) ?? (yield* created.failure);
  });

  /** The whole text of the run's last assistant message. */
  const reply = Effect.fn("WorkflowAgentLinks.reply")(function* (
    turn: AgentTurn,
    environment: string,
  ) {
    let last: OrchestratorMcpThreadReadResult["items"][number] | undefined;
    let afterPosition: number | undefined;
    while (true) {
      const read = yield* call(environment, "t3_thread_read", OrchestratorMcpThreadReadResult, {
        threadId: turn.threadId,
        view: "messages",
        limit: 100,
        ...(afterPosition === undefined ? {} : { afterPosition }),
      });
      last =
        read.items.findLast(
          (item) => item.type === "assistant_message" && item.runId === turn.turnId,
        ) ?? last;
      if (!read.hasMore || read.nextPosition === null) break;
      afterPosition = read.nextPosition;
    }
    if (last === undefined) return "";
    let text = last.text ?? "";
    let textOffset = last.textTruncated ? (last.nextTextOffset ?? null) : null;
    while (textOffset !== null) {
      const rest = yield* call(environment, "t3_thread_read", OrchestratorMcpThreadReadResult, {
        threadId: turn.threadId,
        itemId: last.itemId,
        textOffset,
        maxCharsPerItem: 50_000,
      });
      const part = rest.items[0];
      if (part === undefined) break;
      text += part.text ?? "";
      textOffset = part.textTruncated ? (part.nextTextOffset ?? null) : null;
    }
    return text;
  });

  const start = Effect.fn("WorkflowAgentLinks.start")(function* (
    input: Parameters<Service["start"]>[0],
    environment: string,
    requestId: string,
    here: EnvironmentId,
  ) {
    if (!(yield* links.enabled)) {
      return yield* new WorkflowAgentError({
        reason:
          "Linked environments is off on this machine, so an agent step cannot run in another one. Turn it on in Settings → Labs.",
      });
    }
    const outputSchema =
      input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema };
    if (input.thread !== undefined) {
      const sent = yield* call(environment, "t3_thread_send", OrchestratorMcpThreadSendResult, {
        threadId: input.thread,
        message: input.prompt,
        mode: "queue",
        ...outputSchema,
        clientRequestId: requestId,
      });
      return { threadId: sent.threadId, turnId: sent.runId, environment };
    }
    if (input.project === undefined) {
      return yield* new WorkflowAgentError({
        reason: "An agent step needs a `project` to start in, or a `thread` to continue.",
      });
    }
    const projectId = isProjectPath(input.project)
      ? yield* projectAt(environment, input.project)
      : input.project;
    const launched = yield* call(
      environment,
      "t3_thread_launch",
      ProjectToolkit.tools.t3_thread_launch.successSchema,
      {
        projectId,
        title: input.title,
        ...(input.model === undefined ? {} : { modelSelection: input.model }),
        message: input.prompt,
        ...outputSchema,
        clientRequestId: requestId,
        // The thread there says which run it is a step of, and where that run lives.
        workflowRun: { environmentId: here, ...input.origin },
      },
    );
    if (launched.runId === null) {
      return yield* new WorkflowAgentError({
        reason: `Thread ${launched.threadId} in ${environment} started without a turn for its first message.`,
      });
    }
    return { threadId: launched.threadId, turnId: launched.runId, environment };
  });

  const result = Effect.fn("WorkflowAgentLinks.result")(function* (
    turn: AgentTurn,
    environment: string,
    options?: { readonly quiet?: Duration.Duration | undefined },
  ): Effect.fn.Return<AgentResult, WorkflowAgentError> {
    const ended = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);
    /** The result a later turn submits, or nothing once the thread has been quiet. */
    const owed = Effect.fn("WorkflowAgentLinks.owed")(function* (quiet: Duration.Duration) {
      let left = Duration.toMillis(quiet);
      // The newest turn already seen to end without the result, so quiet is not restarted by it.
      let counted = turn.turnId;
      while (true) {
        const piece = Math.min(left, Duration.toMillis(WAIT_PIECE));
        const waited = yield* call(environment, "t3_thread_wait", OrchestratorMcpThreadWaitResult, {
          threadId: turn.threadId,
          runId: turn.turnId,
          untilOutput: true,
          timeoutMs: piece,
        });
        if (waited.output !== undefined) return Option.some(waited.output);
        // An environment that does not know `untilOutput` answers at once: nothing to wait on.
        if (!waited.timedOut) return Option.none<Schema.Json>();
        left -= piece;
        if (left > 0) continue;
        const read = yield* call(environment, "t3_thread_read", OrchestratorMcpThreadReadResult, {
          threadId: turn.threadId,
          limit: 1,
          runLimit: 1,
        });
        const latest = read.recentRuns[0];
        if (latest === undefined || latest.runId === counted) return Option.none<Schema.Json>();
        // Quiet is counted from the thread's last turn: one under way, or one not yet counted.
        if (ended.has(latest.status)) counted = latest.runId;
        left = Duration.toMillis(quiet);
      }
    });
    while (true) {
      const waited = yield* call(environment, "t3_thread_wait", OrchestratorMcpThreadWaitResult, {
        threadId: turn.threadId,
        runId: turn.turnId,
        timeoutMs: Duration.toMillis(WAIT_PIECE),
      });
      if (waited.timedOut) continue;
      const read = yield* call(environment, "t3_thread_read", OrchestratorMcpThreadReadResult, {
        threadId: turn.threadId,
        limit: 1,
        runLimit: 50,
      });
      const status = read.recentRuns.find((run) => run.runId === turn.turnId)?.status;
      if (status === undefined) {
        return yield* new WorkflowAgentError({
          reason: `Thread ${turn.threadId} in ${environment} no longer lists turn ${turn.turnId}.`,
        });
      }
      if (status === "completed") {
        const output =
          waited.output !== undefined || options?.quiet === undefined
            ? Option.fromUndefinedOr(waited.output)
            : yield* owed(options.quiet);
        return {
          ending: "completed",
          detail: "",
          reply: yield* reply(turn, environment),
          ...(Option.isNone(output) ? {} : { output: output.value }),
        };
      }
      if (
        status === "failed" ||
        status === "interrupted" ||
        status === "cancelled" ||
        status === "rolled_back"
      ) {
        return { ending: status === "failed" ? "failed" : "stopped", detail: status, reply: "" };
      }
      // The wait answered for a turn that has not ended. Asking again at once would spin.
      yield* Effect.sleep("5 seconds");
    }
  });

  const interrupt = (threadId: string, environment: string) =>
    Effect.asVoid(
      call(environment, "t3_thread_interrupt", OrchestratorMcpThreadInterruptResult, {
        threadId,
        reason: "Its workflow run was cancelled",
      }),
    );

  return { start, result, interrupt };
});
