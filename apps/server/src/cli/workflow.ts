import { WorkflowHook } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import * as Workflows from "../workflows/Workflows.ts";
import { WorkflowRun, WorkflowStep } from "../workflows/WorkflowStore.ts";
import { projectLocationFlags } from "./config.ts";
import {
  jsonFlag,
  printJson,
  reportThreadErrors,
  type ThreadTools,
  ThreadUsageError,
  withThreadTools,
} from "./thread.ts";

const RunResult = Schema.Struct({ run: WorkflowRun, steps: Schema.Array(WorkflowStep) });
const RunsResult = Schema.Struct({ runs: Schema.Array(WorkflowRun) });
const QuestionsResult = Schema.Struct({ questions: Schema.Array(Workflows.WorkflowQuestion) });
const HooksResult = Schema.Struct({ hooks: Schema.Array(WorkflowHook) });
const SignalResult = Schema.Struct({ delivery: Schema.Literals(["delivered", "buffered"]) });

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const jsonArgument = (text: string, what: string) =>
  decodeJson(text).pipe(
    Effect.mapError(() => new ThreadUsageError({ detail: `${what} is not valid JSON.` })),
  );

const runLine = (run: WorkflowRun) =>
  [run.runId, run.status.padEnd(9), run.title, run.detail ?? ""].join("  ").trimEnd();

const printRun = Effect.fn("cli.workflow.printRun")(function* (
  result: typeof RunResult.Type,
  json: boolean,
) {
  if (json) return yield* printJson(result);
  yield* Console.log(runLine(result.run));
  for (const step of result.steps) {
    yield* Console.log(
      `  ${step.status.padEnd(9)}  ${step.kind.padEnd(5)}  ${step.name}${
        step.attempts > 1 ? `  (${step.attempts} tries)` : ""
      }${step.environmentId === null ? "" : `  in ${step.environmentId}`}${
        step.detail === null ? "" : `  ${step.detail}`
      }`,
    );
  }
  if (result.run.result !== null) yield* printJson(result.run.result);
});

const runArgument = Argument.String("run").pipe(Argument.withDescription("Run id."));
const act = (tools: ThreadTools, action: "read" | "resume" | "cancel", runId: string) =>
  tools.call("t3_workflow", { action, runId }, RunResult);

const startCommand = Command.make("start", {
  ...projectLocationFlags,
  workflow: Argument.String("workflow").pipe(Argument.withDescription("Workflow name.")),
  input: Flag.String("input").pipe(
    Flag.withDescription("The run's payload, as JSON. Defaults to {}."),
    Flag.withDefault("{}"),
  ),
  key: Flag.String("key").pipe(
    Flag.withDescription("Names this run: starting again with the same key is the same run."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Start a workflow run and print it."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const input = yield* jsonArgument(flags.input, "--input");
      yield* withThreadTools(
        flags,
        Effect.fn("cli.workflow.start")(function* (tools) {
          const started = yield* tools.call(
            "t3_workflow",
            { action: "start", workflow: flags.workflow, input, idempotencyKey: flags.key },
            RunResult,
          );
          yield* printRun(started, flags.json);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const listCommand = Command.make("list", {
  ...projectLocationFlags,
  status: Flag.String("status").pipe(
    Flag.withDescription("Only runs in this state, such as paused or waiting."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List workflow runs, newest first."),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.workflow.list")(function* (tools) {
        const { runs } = yield* tools.call(
          "t3_workflow",
          {
            action: "list",
            ...(Option.isSome(flags.status) ? { status: flags.status.value } : {}),
          },
          RunsResult,
        );
        if (flags.json) return yield* printJson(runs);
        for (const run of runs) yield* Console.log(runLine(run));
      }),
    ).pipe(reportThreadErrors),
  ),
);

const runCommand = (
  name: "show" | "resume" | "cancel",
  action: "read" | "resume" | "cancel",
  description: string,
) =>
  Command.make(name, { ...projectLocationFlags, run: runArgument, json: jsonFlag }).pipe(
    Command.withDescription(description),
    Command.withHandler((flags) =>
      withThreadTools(
        flags,
        Effect.fn("cli.workflow.run")(function* (tools) {
          yield* printRun(yield* act(tools, action, flags.run), flags.json);
        }),
      ).pipe(reportThreadErrors),
    ),
  );

const signalCommand = Command.make("signal", {
  ...projectLocationFlags,
  value: Argument.String("value").pipe(
    Argument.withDescription('What the wait receives, as JSON. A question takes {"choice": ...}.'),
  ),
  run: Flag.String("run").pipe(Flag.withDescription("Run id. Pass with --wait."), Flag.optional),
  wait: Flag.String("wait").pipe(
    Flag.withDescription("The wait's or question's name in that run."),
    Flag.optional,
  ),
  workflow: Flag.String("workflow").pipe(
    Flag.withDescription("Workflow name. Pass with --key when the run is not known."),
    Flag.optional,
  ),
  key: Flag.String("key").pipe(
    Flag.withDescription("The key the wait opened with."),
    Flag.optional,
  ),
  id: Flag.String("id").pipe(
    Flag.withDescription(
      "Names this signal: sending it again with the same id is the same signal.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Wake a waiting run, or answer its question."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const value = yield* jsonArgument(flags.value, "The value");
      yield* withThreadTools(
        flags,
        Effect.fn("cli.workflow.signal")(function* (tools) {
          const { delivery } = yield* tools.call(
            "t3_workflow",
            {
              action: "signal",
              value,
              ...(Option.isSome(flags.run) ? { runId: flags.run.value } : {}),
              ...(Option.isSome(flags.wait) ? { wait: flags.wait.value } : {}),
              ...(Option.isSome(flags.workflow) ? { workflow: flags.workflow.value } : {}),
              ...(Option.isSome(flags.key) ? { key: flags.key.value } : {}),
              ...(Option.isSome(flags.id) ? { signalId: flags.id.value } : {}),
            },
            SignalResult,
          );
          yield* Console.log(
            delivery === "delivered" ? "Delivered." : "Kept until a run waits for it.",
          );
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const questionsCommand = Command.make("questions", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List the questions runs are waiting on a person to answer."),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.workflow.questions")(function* (tools) {
        const { questions } = yield* tools.call(
          "t3_workflow",
          { action: "questions" },
          QuestionsResult,
        );
        if (flags.json) return yield* printJson(questions);
        for (const question of questions) {
          yield* Console.log(`${question.runId}  ${question.name}`);
          yield* printJson(question.request);
        }
      }),
    ).pipe(reportThreadErrors),
  ),
);

const hooksCommand = Command.make("hooks", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List the URL paths that start runs. Each holds its hook's secret; add the server's origin.",
  ),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.workflow.hooks")(function* (tools) {
        const { hooks } = yield* tools.call("t3_workflow", { action: "hooks" }, HooksResult);
        if (flags.json) return yield* printJson(hooks);
        for (const hook of hooks) {
          yield* Console.log(`${hook.workflow}  ${hook.name}  ${hook.path}`);
        }
      }),
    ).pipe(reportThreadErrors),
  ),
);

export const workflowCommand = Command.make("workflow").pipe(
  Command.withDescription("Start, inspect and steer durable workflow runs on the running server."),
  Command.withSubcommands([
    startCommand,
    listCommand,
    runCommand("show", "read", "Show a run and its steps."),
    runCommand("resume", "resume", "Run a paused run's failed step again."),
    runCommand("cancel", "cancel", "Cancel a run."),
    signalCommand,
    questionsCommand,
    hooksCommand,
  ]),
);
