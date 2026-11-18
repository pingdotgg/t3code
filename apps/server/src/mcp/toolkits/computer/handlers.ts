import type {
  ComputerApproval,
  ComputerControl,
  ComputerSnapshot,
  ComputerTaskView,
} from "@t3tools/contracts";
import { ComputerError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as ComputerService from "../../../computer/ComputerService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  type ComputerToolApproval,
  type ComputerToolProgress,
  type ComputerToolStatus,
  ComputerToolkit,
} from "./tools.ts";

/** The capability gate's sentence: it names where the user turns the setting on, and when it applies. */
const COMPUTER_USE_OFF =
  "Agent computer use is turned off for this environment. Ask the user to enable Agent computer use in Settings → Computer use; it applies when the agent session next starts, such as in a new thread.";

const requireComputerUse = McpInvocationContext.requireThreadMcpCapability("computer").pipe(
  Effect.mapError(() => new ComputerError({ reason: "refused", detail: COMPUTER_USE_OFF })),
);

const requesterFor = (scope: McpInvocationContext.McpThreadInvocationScope) =>
  `agent: ${scope.thread.providerInstanceId}`;

/** The safety net for a start whose helper says nothing: a task that reports nothing for this long is out of reach. */
const FIRST_CHANGE_WAIT = "20 seconds";

/** What the agent should do next, so a task waiting for a person is not mistaken for a stuck one. */
function nextStep(task: ComputerTaskView): string {
  if (task.pendingDecision !== null) {
    return "It is waiting for your answers: call computer_use with taskId, decisionId and answers, one per question, using only the keys it offered.";
  }
  switch (task.status) {
    case "running":
      return task.waitingForApproval === null
        ? "It is still running. Call computer_status to follow it."
        : "It is waiting for the user to approve this step in Ada. You cannot approve it: wait for them, or tell them what it is waiting for.";
    case "blocked":
      return "The user denied it, so it has ended. Do not start it again unless the user asks.";
    case "unavailable":
      return "The computer could not do it. Tell the user what it said.";
    case "done":
      return "";
    case "stuck":
    case "stopped":
    case "failed":
      return "It has ended. Tell the user what happened.";
  }
}

const progressForTask = (task: ComputerTaskView): ComputerToolProgress => ({
  task,
  next: nextStep(task),
});

const hostNameFor = (snapshot: ComputerSnapshot, hostId: string) =>
  snapshot.hosts.find((host) => host.hostId === hostId)?.name ?? hostId;

const threadFor = (snapshot: ComputerSnapshot, taskId: string) =>
  snapshot.tasks.find((task) => task.taskId === taskId)?.threadId ?? null;

/** A tap as the agent sees it: enough to wait for or report, never enough to answer it. */
function approvalForTool(
  snapshot: ComputerSnapshot,
  approval: ComputerApproval,
): ComputerToolApproval {
  const { binding } = approval;
  return {
    approvalId: approval.id,
    taskId: binding.taskId,
    step: binding.step,
    app: binding.app,
    title: binding.title,
    url: binding.url,
    why: binding.why,
    hostName: hostNameFor(snapshot, binding.hostId),
    requester: binding.requester,
    threadId: threadFor(snapshot, binding.taskId),
  };
}

function statusForTool(snapshot: ComputerSnapshot, hostId: string | undefined): ComputerToolStatus {
  const hosts =
    hostId === undefined ? snapshot.hosts : snapshot.hosts.filter((host) => host.hostId === hostId);
  const ids = new Set(hosts.map((host) => host.hostId));
  return {
    hosts,
    tasks: snapshot.tasks.filter((task) => ids.has(task.hostId)),
    approvals: snapshot.approvals
      .filter((approval) => approval.state === "pending" && ids.has(approval.binding.hostId))
      .map((approval) => approvalForTool(snapshot, approval)),
  };
}

/** The next thing the agent can act on: progress, a question, a tap, or the end of the task. */
const settled = (task: ComputerTaskView) => (snapshot: ComputerSnapshot) => {
  const current = snapshot.tasks.find((candidate) => candidate.taskId === task.taskId) ?? task;
  const changed = current.steps.length !== task.steps.length || current.surface !== task.surface;
  return current.status !== "running" ||
    current.pendingDecision !== null ||
    current.waitingForApproval !== null ||
    changed
    ? current
    : undefined;
};

/**
 * A start returns as soon as the task does anything: its first step, a question, a tap, or its end.
 * The bound is the safety net for a helper that says nothing at all.
 */
const firstChange = Effect.fn("computerTools.firstChange")(function* (
  service: ComputerService.ComputerService["Service"],
  task: ComputerTaskView,
) {
  const stream = yield* service.subscribe;
  const found = yield* stream.pipe(
    Stream.filterMap((snapshot) => {
      const current = settled(task)(snapshot);
      return current === undefined ? Result.failVoid : Result.succeed(current);
    }),
    Stream.take(1),
    Stream.runHead,
    Effect.timeoutOption(FIRST_CHANGE_WAIT),
  );
  return progressForTask(Option.flatten(found).pipe(Option.getOrElse(() => task)));
});

const controlOf = (input: {
  readonly kind: ComputerControl["kind"];
  readonly app?: string | undefined;
  readonly action?: string | undefined;
  readonly target?: string | undefined;
  readonly player?: string | undefined;
  readonly level?: number | undefined;
}): ComputerControl => ({
  kind: input.kind,
  ...(input.app === undefined ? {} : { app: input.app }),
  ...(input.action === undefined ? {} : { action: input.action }),
  ...(input.target === undefined ? {} : { target: input.target }),
  ...(input.player === undefined ? {} : { player: input.player }),
  ...(input.level === undefined ? {} : { level: input.level }),
});

const taskIn = (snapshot: ComputerSnapshot, taskId: string) =>
  snapshot.tasks.find((task) => task.taskId === taskId);

const handlers = {
  computer_status: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* requireComputerUse;
      const service = yield* ComputerService.ComputerService;
      return statusForTool(yield* service.status, input?.hostId);
    }),
  ),
  computer_control: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireComputerUse;
      const service = yield* ComputerService.ComputerService;
      const task = yield* service.control({
        control: controlOf(input),
        requester: requesterFor(scope),
        threadId: scope.thread.threadId,
        ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
      });
      return progressForTask(task);
    }),
  ),
  computer_use: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireComputerUse;
      const service = yield* ComputerService.ComputerService;
      // `taskId` alone reports the task; with `decisionId` it answers the questions it waits on.
      if (input.taskId !== undefined) {
        if (input.decisionId !== undefined) {
          yield* service.answerDecision({
            taskId: input.taskId,
            decisionId: input.decisionId,
            answers: input.answers ?? {},
            answeredBy: requesterFor(scope),
          });
        } else if (input.answers !== undefined) {
          return yield* new ComputerError({
            reason: "refused",
            detail: "Pass the `decisionId` the questions came with, with `answers`.",
            taskId: input.taskId,
          });
        }
        const snapshot = yield* service.status;
        const task = taskIn(snapshot, input.taskId);
        if (task === undefined) {
          return yield* new ComputerError({
            reason: "not_found",
            detail: "That task is not known here.",
            taskId: input.taskId,
          });
        }
        return progressForTask(task);
      }
      if (input.goal === undefined) {
        return yield* new ComputerError({
          reason: "refused",
          detail:
            "Give `goal` to start a task, or `taskId`, `decisionId` and `answers` to answer the questions of one running.",
        });
      }

      const task = yield* service.startUse({
        goal: input.goal,
        requester: requesterFor(scope),
        threadId: scope.thread.threadId,
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
      });
      return yield* firstChange(service, task);
    }),
  ),
  computer_stop: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireComputerUse;
      const service = yield* ComputerService.ComputerService;
      yield* service.stop({
        by: requesterFor(scope),
        ...(input?.taskId === undefined ? {} : { taskId: input.taskId }),
      });
      return statusForTool(yield* service.status, undefined);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ComputerToolkit.tools>;

export const layer = McpToolAccess.toLayer(ComputerToolkit, handlers);
