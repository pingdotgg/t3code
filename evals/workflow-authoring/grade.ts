// Grades a workflow file the way the server would use it: loaded by the real loader, registered
// in the real engine on a throwaway database, and driven with a stand-in for agents.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import Migration0092 from "../../apps/server/src/persistence/Migrations/092_Workflows.ts";
import Migration0093 from "../../apps/server/src/persistence/Migrations/093_WorkflowTriggers.ts";
import Migration0094 from "../../apps/server/src/persistence/Migrations/094_WorkflowStepEnvironment.ts";
import Migration0095 from "../../apps/server/src/persistence/Migrations/095_WorkflowRunInput.ts";
import type { WorkflowDefinition } from "../../apps/server/src/workflows/workflow.ts";
import {
  type AgentResult,
  WorkflowAgents,
} from "../../apps/server/src/workflows/WorkflowAgents.ts";
import * as WorkflowEngine from "../../apps/server/src/workflows/WorkflowEngine.ts";
import { loadDefinitions } from "../../apps/server/src/workflows/WorkflowRuntime.ts";
import * as Workflows from "../../apps/server/src/workflows/Workflows.ts";
import type { WorkflowRun } from "../../apps/server/src/workflows/WorkflowStore.ts";

export type AgentTurnInput = Parameters<WorkflowAgents["Service"]["start"]>[0];

/** One server holding the file's workflows. `restart` is the same database under a new engine. */
export interface World {
  readonly definitions: ReadonlyArray<WorkflowDefinition>;
  /** Every agent turn the workflows asked for, in order. */
  readonly turns: ReadonlyArray<AgentTurnInput>;
  readonly server: <A>(
    use: (workflows: Workflows.Workflows["Service"]) => Effect.Effect<A, Workflows.WorkflowError>,
  ) => Effect.Effect<A, Workflows.WorkflowError>;
  /** The run once it is in one of these states, or nothing after ten seconds. */
  readonly reaches: (
    workflows: Workflows.Workflows["Service"],
    runId: string,
    ...statuses: ReadonlyArray<WorkflowRun["status"]>
  ) => Effect.Effect<Option.Option<WorkflowRun>>;
  /** The name of the question the run asks a person, or nothing after ten seconds. */
  readonly asks: (
    workflows: Workflows.Workflows["Service"],
    runId: string,
  ) => Effect.Effect<Option.Option<string>>;
}

export interface Case {
  readonly id: string;
  readonly source: string;
  /** What the model is asked to write. */
  readonly task: string;
  /** What a fake agent answers. Each scenario of the case sets its own. */
  readonly scenarios: ReadonlyArray<{
    readonly name: string;
    readonly agent: (turn: AgentTurnInput) => Partial<AgentResult>;
    /** The problems found. None is a pass. */
    readonly check: (world: World) => Effect.Effect<ReadonlyArray<string>, Workflows.WorkflowError>;
  }>;
}

const world = Effect.fn("gradeWorkflow.world")(function* (
  definitions: ReadonlyArray<WorkflowDefinition>,
  agent: (turn: AgentTurnInput) => Partial<AgentResult>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflow-eval-" });
  const database = NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") });
  yield* Effect.provide(
    Effect.all([Migration0092, Migration0093, Migration0094, Migration0095], { discard: true }),
    database,
  );
  const turns: Array<AgentTurnInput> = [];
  const asked = new Map<string, AgentTurnInput>();
  const agents = WorkflowAgents.of({
    start: Effect.fn("gradeWorkflow.agents.start")(function* (input) {
      if (!asked.has(input.key)) {
        asked.set(input.key, input);
        turns.push(input);
      }
      return yield* Effect.succeed({
        threadId: input.thread ?? `thread-${input.key}`,
        turnId: input.key,
      });
    }),
    result: Effect.fn("gradeWorkflow.agents.result")(function* (turn) {
      return yield* Effect.succeed({
        ending: "completed" as const,
        detail: "",
        reply: "",
        ...agent(asked.get(turn.turnId)!),
      });
    }),
    interrupt: Effect.fn("gradeWorkflow.agents.interrupt")(function* () {
      return yield* Effect.void;
    }),
  });
  const engine = WorkflowEngine.layer(definitions).pipe(
    Layer.provide(Layer.succeed(WorkflowAgents, agents)),
    Layer.provide(database),
    Layer.provide(NodeCrypto.layer),
    Layer.orDie,
  );
  return {
    definitions,
    turns,
    server: (use) =>
      Effect.scoped(Effect.provide(Effect.flatMap(Workflows.Workflows, use), engine)),
    reaches: (workflows, runId, ...statuses) =>
      workflows
        .waitFor(runId, (run) => statuses.includes(run.status))
        .pipe(Effect.timeoutOption("10 seconds")),
    asks: (workflows, runId) =>
      workflows.watch.pipe(
        Stream.filterMap((snapshot) => {
          const question = snapshot.questions.find((asked) => asked.runId === runId);
          return question === undefined ? Result.failVoid : Result.succeed(question.name);
        }),
        Stream.runHead,
        Effect.timeoutOption("10 seconds"),
        Effect.map(Option.flatten),
      ),
  } satisfies World;
});

const problemsWith = Effect.fn("gradeWorkflow.problemsWith")(function* (file: string, entry: Case) {
  const loaded = yield* Effect.result(loadDefinitions(file));
  if (loaded._tag === "Failure") {
    return [`The file does not load: ${String(loaded.failure.cause)}`];
  }
  const problems: Array<string> = [];
  for (const scenario of entry.scenarios) {
    const found = yield* world(loaded.success, scenario.agent).pipe(
      Effect.flatMap(scenario.check),
      Effect.scoped,
      Effect.catch((error) => Effect.succeed([error.message])),
      Effect.catchDefect((defect) => Effect.succeed([`It crashed: ${String(defect)}`])),
    );
    problems.push(...found.map((problem) => `${scenario.name}: ${problem}`));
  }
  return problems;
});

/** The problems with the workflow file at `file` as an answer to `entry`. None is a pass. */
export const grade = (file: string, entry: Case): Promise<ReadonlyArray<string>> =>
  Effect.runPromise(Effect.provide(problemsWith(file, entry), NodeServices.layer));
