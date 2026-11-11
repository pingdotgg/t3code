// The steps that involve someone else: an agent that returns data, and a person who answers.
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  claim,
  type InRun,
  journaled,
  jsonSchemaOf,
  type StepFailed,
  text,
  waitAs,
} from "./workflow.ts";
import { type AgentModel, AgentResult, AgentTurn, WorkflowAgents } from "./WorkflowAgents.ts";

/** A thread an agent step ran in, to hand to a later step that should continue it. */
export interface AgentThread {
  readonly threadId: string;
}

const CORRECTIONS = 2;

/**
 * An agent doing one job in a thread a person can open. With `output` it returns data the server
 * checked against that schema; without, its last message. It starts a thread in `project`, or
 * continues `thread`. A turn that dies is tried once more, then the run pauses at this step.
 */
export const agent = Effect.fn("workflow.agent")(function* <A = string, I = string>(
  name: string,
  options: {
    readonly brief: string;
    readonly output?: Schema.Codec<A, I>;
    readonly model?: AgentModel;
    readonly project?: string;
    readonly thread?: AgentThread;
  },
): Effect.fn.Return<{ readonly value: A; readonly thread: AgentThread }, StepFailed, InRun> {
  const run = yield* claim(name);
  const agents = yield* WorkflowAgents;
  const outputSchema = options.output === undefined ? undefined : jsonSchemaOf(options.output);
  const outputCodec = options.output === undefined ? undefined : Schema.toCodecJson(options.output);
  const decodeOutput = outputCodec === undefined ? undefined : Schema.decodeEffect(outputCodec);
  const start = (key: string, prompt: string, thread: string | undefined) =>
    agents
      .start({
        key: `${run.runId}/${name}/${key}`,
        title: `${run.workflow}: ${name}`,
        prompt,
        outputSchema,
        model: options.model,
        project: options.project,
        thread,
      })
      .pipe(Effect.tap((turn) => run.store.stepThread(run.runId, name, turn.threadId)));
  const done = (round: number) =>
    journaled(
      run,
      name,
      `agent/${name}/${round}/done`,
      Schema.Void,
      Effect.andThen(
        run.store.stepEnded(run.runId, name, "completed", null),
        run.store.runStatus(run.runId, "running", null),
      ),
    );

  for (let round = 0; ; round++) {
    let turn = yield* journaled(
      run,
      name,
      `agent/${name}/${round}/start`,
      AgentTurn,
      Effect.andThen(
        run.store.stepStarted(run.runId, name, "agent"),
        start(`${round}`, options.brief, options.thread?.threadId),
      ),
    );
    let problem = "";
    let stopped = false;
    for (let correction = 0; ; correction++) {
      const result = yield* journaled(
        run,
        name,
        `agent/${name}/${round}/result/${correction}`,
        AgentResult,
        Effect.andThen(
          run.store.runStatus(run.runId, "waiting", `agent ${name}`),
          agents.result(turn),
        ),
      );
      if (result.ending !== "completed") {
        stopped = result.ending === "stopped";
        problem = `the agent's turn was ${stopped ? "stopped" : "cut short"}: ${result.detail}`;
        break;
      }
      if (decodeOutput === undefined) {
        yield* done(round);
        return { value: result.reply as A, thread: { threadId: turn.threadId } };
      }
      const decoded =
        result.output === undefined
          ? Result.fail("it ended its turn without submitting a result")
          : yield* decodeOutput(result.output).pipe(
              Effect.mapError((error) => `its result no longer fits: ${text(error)}`),
              Effect.result,
            );
      if (Result.isSuccess(decoded)) {
        yield* done(round);
        return { value: decoded.success, thread: { threadId: turn.threadId } };
      }
      problem = `the agent did not return a result: ${decoded.failure}`;
      if (correction >= CORRECTIONS) break;
      // Back to the same thread: it has the context and only owes the result.
      turn = yield* journaled(
        run,
        name,
        `agent/${name}/${round}/correct/${correction}`,
        AgentTurn,
        start(
          `${round}/correct/${correction}`,
          "Your turn ended without a submitted result. Do not redo the work: call `t3_submit_output` now with the result of what you did.",
          turn.threadId,
        ),
      );
    }
    // A turn that died is not the job's fault the first time: once more, on a thread of its own.
    // One a person stopped is not tried again behind their back.
    if (round % 2 === 0 && !stopped) continue;
    // Fails the first time it is reached, which pauses the run here. Resuming the run reaches it
    // again, and the next round starts.
    yield* journaled(
      run,
      name,
      `agent/${name}/${round}/pause`,
      Schema.Void,
      Effect.flatMap(run.store.mark(run.runId, `${name}/pause/${round}`), (arrivals) =>
        arrivals > 1 ? Effect.void : Effect.fail(problem),
      ),
    );
  }
});

/**
 * A question a person answers with one of `choices`; `None` when the timeout passes first. The run
 * holds nothing while it waits. `data` is the same facts as the title, for whatever lays the
 * question out.
 */
export const ask = <const Choices extends ReadonlyArray<string>>(
  name: string,
  options: {
    readonly title: string;
    readonly choices: Choices;
    readonly data?: Schema.Json;
    readonly timeout?: Parameters<typeof waitAs>[2]["timeout"];
  },
): Effect.Effect<
  Option.Option<{ readonly choice: Choices[number]; readonly reason?: string | undefined }>,
  StepFailed,
  InRun
> =>
  waitAs("ask", name, {
    returns: Schema.Struct({
      choice: Schema.Literals(options.choices),
      reason: Schema.optional(Schema.String),
    }),
    timeout: options.timeout,
    request: {
      title: options.title,
      choices: [...options.choices],
      ...(options.data === undefined ? {} : { data: options.data }),
    },
  });
