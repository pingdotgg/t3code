// @effect-diagnostics nodeBuiltinImport:off
/**
 * T3's computer tools over a case's world. McpHttpServer's computer toolkit runs T3's handlers on a
 * scripted ComputerService, so every sentence the agent reads is T3's own.
 */
import {
  type ComputerApproval,
  type ComputerApprovalId,
  type ComputerApprovalsMode,
  type ComputerAnswers,
  type ComputerHostId,
  type ComputerHostView,
  type ComputerLook,
  ComputerError,
  type ComputerPlannerAnswers,
  type ComputerQuestions,
  type ComputerSnapshot,
  type ComputerTaskId,
  type ComputerTaskStatus,
  type ComputerTaskView,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- the eval calls the computer tools McpHttpServer registered and registers none.
import { McpSchema, McpServer } from "effect/ai";

import { keepValid } from "../../apps/server/src/computer/ComputerDecider.ts";
import * as ComputerService from "../../apps/server/src/computer/ComputerService.ts";
import * as McpHttpServer from "../../apps/server/src/mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../apps/server/src/mcp/McpInvocationContext.ts";
import { liveThreadsLayer } from "../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import {
  ComputerLookToolkit,
  ComputerToolkit,
} from "../../apps/server/src/mcp/toolkits/computer/tools.ts";

/** What a started task does next, as a case's world scripts it. */
export type ComputerOutcome = "questions" | "tap" | "done" | "blocked";

export interface ComputerWorld {
  /** false: the setting is off, so the thread holds no `computer` capability. Defaults to on. */
  readonly computerAgentAccess?: boolean | undefined;
  /** The computer's name. Defaults to "JJ's MacBook". */
  readonly hostName?: string | undefined;
  /** What the next started task does. Defaults to "questions". */
  readonly outcome?: ComputerOutcome | undefined;
  /** The questions a "questions" task asks. Defaults to one choice with three keys. */
  readonly questions?: ComputerQuestions | undefined;
  /** Whether the user has approved consequential steps automatically. Defaults to "ask". */
  readonly approvals?: ComputerApprovalsMode | undefined;
  /** The visible text an ended use task's screen showed. */
  readonly screenText?: string | undefined;
  /** What computer_look reads. Defaults to an empty Finder window. */
  readonly screen?: ComputerLook | undefined;
}

export const isComputerTool = (name: string) =>
  Object.hasOwn(ComputerToolkit.tools, name) || Object.hasOwn(ComputerLookToolkit.tools, name);

const DEFAULT_QUESTIONS: ComputerQuestions = {
  next: {
    type: "choice",
    instructions: "What should the next step be?",
    criteria: {
      c0: "Add the note to the list",
      c1: "Open another note first",
      stuck: "None of these",
    },
  },
};

const AT = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const EXPIRES_AT = DateTime.makeUnsafe("2026-01-01T00:01:00.000Z");
const THREAD = ThreadId.make("mcp-tool-use-eval");
const HOST_ID = "host_eval" as ComputerHostId;
const REQUESTER = "agent: codex";

const finished = (outcome: ComputerOutcome): ComputerTaskStatus | null =>
  outcome === "questions" || outcome === "tap" ? null : outcome;

/** What a person would see in front of them, so the task's window matches what was asked. */
const windowFor = (goal: string) =>
  /messages/i.test(goal)
    ? { app: "Messages", title: "Dana" }
    : /notes/i.test(goal)
      ? { app: "Notes", title: "Groceries" }
      : { app: "Finder", title: "" };

const surfaceOf = (goal: string) => {
  const { app, title } = windowFor(goal);
  return title === "" ? app : `${app} — ${title}`;
};

const hostView = (name: string, busyTaskId: ComputerTaskId | null): ComputerHostView => ({
  hostId: HOST_ID,
  name,
  device: "mac",
  platform: "darwin",
  version: "1.0",
  controls: ["open_app", "quit_app", "volume", "media", "dark_mode", "lock_screen"],
  computerUse: true,
  accessibility: true,
  screenRecording: true,
  busyTaskId,
  connectedAt: AT,
});

const taskView = (input: {
  readonly id: string;
  readonly kind: "control" | "use";
  readonly goal: string;
  readonly hostName: string;
  readonly outcome: ComputerOutcome;
  readonly questions: ComputerQuestions;
  readonly approvals: ComputerApprovalsMode;
  readonly screenText: string | undefined;
}): ComputerTaskView => {
  const ended = finished(input.outcome);
  return {
    taskId: input.id as ComputerTaskId,
    kind: input.kind,
    hostId: HOST_ID,
    hostName: input.hostName,
    goal: input.goal,
    status: ended ?? "running",
    reason:
      input.outcome === "blocked"
        ? "You said no on the approval screen."
        : input.outcome === "done"
          ? "Done."
          : "",
    surface: input.kind === "use" ? surfaceOf(input.goal) : "",
    steps: [],
    requester: REQUESTER,
    threadId: THREAD,
    startedAt: AT,
    endedAt: ended === null ? null : AT,
    waitingForApproval: (input.outcome === "tap" ? "appr_eval" : null) as ComputerApprovalId | null,
    pendingDecision:
      input.outcome === "questions" ? { id: "dec_eval", questions: input.questions } : null,
    approvalsMode: input.approvals,
    ...(input.kind === "use" && ended !== null && input.screenText !== undefined
      ? { screenText: input.screenText }
      : {}),
  };
};

const approvalView = (task: ComputerTaskView): ComputerApproval => {
  // The card names the same window the task's surface does.
  const { app, title } = windowFor(task.goal);
  return {
    id: "appr_eval" as ComputerApprovalId,
    binding: {
      hostId: task.hostId,
      taskId: task.taskId,
      step: 1,
      app,
      title,
      url: "",
      action: { kind: "click", ref: "r1", role: "button", label: "Add to list" },
      why: "its label reads as sending or posting",
      goal: task.goal,
      requester: REQUESTER,
    },
    createdAt: AT,
    expiresAt: EXPIRES_AT,
    state: "pending",
    decidedBy: "",
  };
};

/** One sample's computer tools, answered by T3's handlers over a scripted computer. */
export interface ComputerTools {
  readonly call: (
    name: string,
    input: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<{ readonly text: string; readonly isError: boolean }>;
}

const plannerAnswers = (
  questions: ComputerQuestions,
  answers: ComputerPlannerAnswers,
): Readonly<Record<string, ComputerAnswers[string]>> => {
  const probability = (confidence: "high" | "medium" | "low") =>
    confidence === "high" ? 0.9 : confidence === "medium" ? 0.6 : 0.3;
  const converted: Record<string, ComputerAnswers[string]> = {};
  for (const [id, answer] of Object.entries(answers)) {
    const question = questions[id];
    if (question === undefined) continue;
    const p = probability(answer.confidence);
    if (question.type === "choice") {
      if (answer.choice !== undefined && Object.hasOwn(question.criteria, answer.choice)) {
        converted[id] = { type: "choice", choice: answer.choice, probability: p };
      }
      continue;
    }
    if (answer.answer !== undefined) {
      converted[id] = { type: "noul", probability: answer.answer ? p : 1 - p };
    } else if (answer.choice === "yes" || answer.choice === "no") {
      converted[id] = { type: "noul", probability: answer.choice === "yes" ? p : 1 - p };
    }
  }
  return converted;
};

export const makeComputerTools = Effect.fn("evaluateMcpToolUse.makeComputerTools")(function* (
  world: ComputerWorld,
) {
  const hostName = world.hostName ?? "JJ's MacBook";
  const outcome = world.outcome ?? "questions";
  const questions = world.questions ?? DEFAULT_QUESTIONS;
  const approvals = world.approvals ?? "ask";
  const state = yield* Ref.make<{ tasks: ReadonlyArray<ComputerTaskView>; next: number }>({
    tasks: [],
    next: 1,
  });
  const snapshot = Effect.map(Ref.get(state), ({ tasks }) => {
    const running = tasks.find((task) => task.status === "running");
    const waiting = running?.waitingForApproval;
    return {
      hosts: [hostView(hostName, running?.taskId ?? null)],
      tasks: [...tasks].reverse(),
      approvals: running === undefined || waiting == null ? [] : [approvalView(running)],
    } satisfies ComputerSnapshot;
  });
  const addTask = Effect.fn("evalComputer.addTask")(function* (
    kind: "control" | "use",
    goal: string,
    scripted: ComputerOutcome = outcome,
  ) {
    const { next } = yield* Ref.get(state);
    const task = taskView({
      id: `${kind === "use" ? "cu" : "cc"}_eval_${next}`,
      kind,
      goal,
      hostName,
      outcome: scripted,
      questions,
      approvals,
      screenText: world.screenText,
    });
    yield* Ref.update(state, (current) => ({
      next: next + 1,
      tasks: [...current.tasks, task] as ReadonlyArray<ComputerTaskView>,
    }));
    return task;
  });

  const first = <A extends ReadonlyArray<ComputerTaskView>>(tasks: A) =>
    tasks as ReadonlyArray<ComputerTaskView>;
  const service = ComputerService.ComputerService.of({
    control: Effect.fn("ComputerService.control")((input) =>
      addTask(
        "control",
        input.control.app === undefined ? input.control.kind : `open ${input.control.app}`,
      ),
    ),
    startUse: Effect.fn("ComputerService.startUse")((input) => addTask("use", input.goal)),
    // An act asks no questions: it ends, or waits for the user's tap or denial as the world says.
    act: Effect.fn("ComputerService.act")((input) =>
      addTask(
        "use",
        `${input.act.action} ${input.act.label ?? input.act.ref ?? input.act.key ?? input.act.url ?? ""}`.trim(),
        outcome === "tap" || outcome === "blocked" ? outcome : "done",
      ),
    ),
    look: Effect.fn("ComputerService.look")(() =>
      Effect.succeed(world.screen ?? { app: "Finder", title: "", text: "", controls: [] }),
    ),
    answerDecision: Effect.fn("ComputerService.answerDecision")(function* (input) {
      const { tasks } = yield* Ref.get(state);
      const task = tasks.find((candidate) => candidate.taskId === input.taskId);
      if (task === undefined) {
        return yield* new ComputerError({
          reason: "not_found",
          detail: "That task is not known here.",
        });
      }
      const asked = task.pendingDecision?.questions ?? {};
      yield* Ref.update(state, (current) => ({
        next: current.next,
        tasks: first(
          current.tasks.map((candidate) =>
            candidate.taskId === task.taskId
              ? {
                  ...candidate,
                  status: "done" as const,
                  reason: "Done.",
                  pendingDecision: null,
                  endedAt: AT,
                }
              : candidate,
          ),
        ),
      }));
      return keepValid(asked, plannerAnswers(asked, input.answers));
    }),
    status: snapshot,
    stop: Effect.fn("ComputerService.stop")(() =>
      Ref.update(state, (current) => ({
        next: current.next,
        tasks: first(
          current.tasks.map((task) =>
            task.status === "running"
              ? { ...task, status: "stopped" as const, reason: "You stopped it.", endedAt: AT }
              : task,
          ),
        ),
      })),
    ),
    subscribe: Effect.map(snapshot, (current) => Stream.make(current)),
    // The toolkit's calls above are the whole surface these cases use.
    stopForThread: Effect.fn("ComputerService.stopForThread")(() => Effect.void),
    respondToApproval: Effect.fn("ComputerService.respondToApproval")(() => Effect.void),
    auditTail: Effect.fn("ComputerService.auditTail")(() => Effect.succeed([])),
    hostConnect: () => Stream.empty,
    hostRespond: Effect.fn("ComputerService.hostRespond")(() => Effect.void),
    hostDecide: Effect.fn("ComputerService.hostDecide")(() =>
      Effect.die("a scripted computer asks nothing"),
    ),
    hostAuthorize: Effect.fn("ComputerService.hostAuthorize")(() =>
      Effect.die("a scripted computer asks nothing"),
    ),
    hostEvent: Effect.fn("ComputerService.hostEvent")(() => Effect.void),
    attachLocalHost: Effect.fn("ComputerService.attachLocalHost")(() =>
      Effect.die("a scripted computer attaches nothing"),
    ),
  });

  const context = yield* Layer.build(
    McpHttpServer.layerComputerToolkit.pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provideMerge(Layer.succeed(ComputerService.ComputerService, service)),
      Layer.provideMerge(liveThreadsLayer),
    ),
  );
  type Entry = Parameters<McpServer.McpServer["Service"]["addTool"]>[0];
  const tools = Context.get(context, McpServer.McpServer).tools as ReadonlyArray<Entry>;
  const scope: McpInvocationContext.McpThreadInvocationScope = {
    environmentId: EnvironmentId.make("00000000-0000-4000-8000-0000000000e1"),
    requestNamespace: "mcp-tool-use-eval",
    thread: {
      threadId: THREAD,
      providerSessionId: "mcp-tool-use-eval",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    // A thread holds `computer` when the setting was on as its session started.
    capabilities: new Set<McpInvocationContext.McpCapability>(
      world.computerAgentAccess === false ? [] : ["computer"],
    ),
    issuedAt: 0,
  };
  const request = McpSchema.McpRequestContext.of({
    clientId: 0,
    protocolVersion: "2025-06-18",
    clientCapabilities: {},
  });
  const call = Effect.fn("evaluateMcpToolUse.computerCall")(function* (
    name: string,
    input: Readonly<Record<string, unknown>>,
  ) {
    const entry = tools.find((tool) => tool.tool.name === name);
    if (entry === undefined) {
      return yield* Effect.die(new Error(`T3 has no computer tool ${name}.`));
    }
    const result = yield* entry.handle(input).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpRequestContext, request),
      // An MCP client shows a failure as the tool's error text.
      Effect.catch((error: { readonly message?: string }) =>
        Effect.succeed(
          new McpSchema.CallToolResult({
            isError: true,
            content: [{ type: "text", text: error.message ?? `${name} failed.` }],
          }),
        ),
      ),
    );
    if (!("content" in result)) {
      return yield* Effect.die(new Error(`${name} asked for input.`));
    }
    const text = result.content
      .flatMap((part: { readonly type: string; readonly text?: string }) =>
        part.type === "text" && part.text !== undefined ? [part.text] : [],
      )
      .join("\n");
    if (text === "Tool execution failed due to an internal server error.") {
      return yield* Effect.die(new Error(`${name} hit a defect in T3 or the eval's world.`));
    }
    return { text, isError: result.isError === true };
  });
  return { call } satisfies ComputerTools;
});
