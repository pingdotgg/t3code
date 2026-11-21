// The steps that involve someone else: an agent that returns data, and a person who answers.
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { checkOptions } from "./options.ts";
import {
  claim,
  type InRun,
  journaled,
  jsonSchemaOf,
  type StepFailed,
  text,
  waitAs,
} from "./workflow.ts";
import type { IssueAddress } from "./WorkflowForge.ts";
import {
  type AgentLaunch,
  type AgentModel,
  AgentResult,
  AgentTurn,
  WorkflowAgents,
} from "./WorkflowAgents.ts";

/** A thread an agent step ran in, to hand to a later step that should continue it. */
export interface AgentThread {
  readonly threadId: string;
  /** The linked environment it is in. Absent for this one. */
  readonly environment?: string | undefined;
}

const CORRECTIONS = 2;

export interface AgentOptions<A, I> extends AgentLaunch {
  readonly brief: string;
  /** The new thread's title. `<workflow>: <step>` by default. */
  readonly title?: string;
  readonly returns?: Schema.Codec<A, I>;
  readonly model?: AgentModel;
  readonly project?: string;
  readonly environment?: string;
  readonly thread?: AgentThread;
  /**
   * The issue this job is about. Its thread shows the issue, and the issue's page lists the
   * thread. Only for a thread on this server, not one in a linked `environment`.
   */
  readonly issue?: IssueAddress;
  /** How long the agent has. Past it the thread is stopped and the step has failed. */
  readonly timeout?: Duration.Input;
  /**
   * Let the agent end a turn without its `returns` and answer from a later one, as an agent does
   * that waits to be woken: by a pull request it watches, by work it left running. Only when
   * its thread has done nothing for this long is it asked for the result. Without it, a turn
   * that ends without the result is asked at once.
   */
  readonly quiet?: Duration.Input;
}

type Attempt<A> =
  | { readonly outcome: "done"; readonly value: A; readonly thread: AgentThread }
  | { readonly outcome: "failed"; readonly reason: string; readonly thread?: AgentThread };

const AGENT_OPTIONS = [
  "brief",
  "returns",
  "model",
  "project",
  "environment",
  "thread",
  "issue",
  "timeout",
  "quiet",
  "title",
  "workspace",
  "runtimeMode",
  "interactionMode",
];

// What only shapes a new thread: a continued one keeps its project, machine, model and modes.
const NEW_THREAD_OPTIONS = [
  "project",
  "environment",
  "model",
  "title",
  "workspace",
  "runtimeMode",
  "interactionMode",
] as const;

const attempt = Effect.fn("workflow.agent")(function* <A, I>(
  name: string,
  options: AgentOptions<A, I>,
  /** What a failure does: pause the run at this step, or come back as the step's answer. */
  onFailure: "pause" | "return",
): Effect.fn.Return<Attempt<A>, StepFailed, InRun> {
  checkOptions(`agent("${name}")`, options, AGENT_OPTIONS);
  if (options.thread !== undefined) {
    const shaping = NEW_THREAD_OPTIONS.filter((key) => options[key] !== undefined);
    if (shaping.length > 0) {
      return yield* Effect.die(
        new Error(
          `agent("${name}") continues \`thread\`, which keeps how it started. Drop ${shaping.map((key) => `\`${key}\``).join(", ")}.`,
        ),
      );
    }
  }
  const run = yield* claim(name);
  const agents = yield* WorkflowAgents;
  const outputSchema = options.returns === undefined ? undefined : jsonSchemaOf(options.returns);
  // Only a turn asked for a result can owe one from a later turn.
  const quiet =
    options.quiet === undefined || outputSchema === undefined
      ? undefined
      : Duration.fromInputUnsafe(options.quiet);
  const outputCodec =
    options.returns === undefined ? undefined : Schema.toCodecJson(options.returns);
  const decodeOutput = outputCodec === undefined ? undefined : Schema.decodeEffect(outputCodec);
  const threadOf = (turn: AgentTurn): AgentThread => ({
    threadId: turn.threadId,
    ...(turn.environment === undefined ? {} : { environment: turn.environment }),
  });
  const launch: AgentLaunch | undefined =
    options.workspace === undefined &&
    options.runtimeMode === undefined &&
    options.interactionMode === undefined
      ? undefined
      : {
          workspace: options.workspace,
          runtimeMode: options.runtimeMode,
          interactionMode: options.interactionMode,
        };
  const start = (key: string, prompt: string, thread: AgentThread | undefined) =>
    agents
      .start({
        key: `${run.runId}/${name}/${key}`,
        origin: { runId: run.runId, workflow: run.workflow, step: name },
        title: options.title ?? `${run.workflow}: ${name}`,
        // Only the step's own `thread` is refused them; a correction on the thread it made is not.
        launch: thread === undefined || thread === options.thread ? launch : undefined,
        prompt,
        outputSchema,
        model: options.model,
        project: options.project,
        environment: thread === undefined ? options.environment : thread.environment,
        thread: thread?.threadId,
        issue: options.issue,
      })
      .pipe(
        Effect.tap((turn) =>
          run.store.stepThread(
            run.runId,
            name,
            turn.threadId,
            turn.environment ?? null,
            turn.turnId,
          ),
        ),
        Effect.flatMap((turn) =>
          Effect.map(Clock.currentTimeMillis, (startedAt): AgentTurn => ({ ...turn, startedAt })),
        ),
        // No machine, no project, no link: for a step that takes failure as an answer, that is one.
        onFailure === "pause"
          ? identity
          : Effect.catch((error) =>
              Effect.succeed<AgentTurn>({ threadId: "", turnId: "", failed: text(error) }),
            ),
      );
  const resultOf = (turn: AgentTurn, wait = { quiet }) =>
    agents
      .result(turn, wait)
      .pipe(
        onFailure === "pause"
          ? identity
          : Effect.catch((error) =>
              Effect.succeed<AgentResult>({ ending: "failed", detail: text(error), reply: "" }),
            ),
      );
  /** The turn's result, or its thread stopped when the step's time is up. */
  const within = Effect.fn("workflow.agent.within")(function* (
    turn: AgentTurn,
    startedAt: number | undefined,
  ) {
    if (options.timeout === undefined || startedAt === undefined) return yield* resultOf(turn);
    const limit = Duration.fromInputUnsafe(options.timeout);
    const left = startedAt + Duration.toMillis(limit) - (yield* Clock.currentTimeMillis);
    const result = yield* resultOf(turn).pipe(
      Effect.timeoutOption(Duration.millis(Math.max(0, left))),
    );
    if (Option.isSome(result)) return result.value;
    // A stop that still fails pauses the run unrecorded, so resuming tries the stop again. A step
    // that returns its failure says the turn may still be running.
    const stopping = agents
      .interrupt({ ...threadOf(turn), turnId: turn.turnId })
      .pipe(Effect.retry({ times: 2 }));
    const stop: "stopped" | "ended" | "failed" = yield* onFailure === "pause"
      ? stopping
      : stopping.pipe(Effect.orElseSucceed(() => "failed" as const));
    const late = `it was not done after ${Duration.format(limit)}`;
    if (stop === "ended") {
      // The turn ended before it could be stopped, maybe long ago, as a run that resumes late
      // finds it. What it left is the answer when it is one.
      const ended = yield* resultOf(turn, { quiet: undefined });
      if (
        ended.ending !== "completed" ||
        outputSchema === undefined ||
        ended.output !== undefined
      ) {
        return ended;
      }
      // Stopping the later turn it may answer from could stop someone else's.
      return {
        ending: "stopped" as const,
        detail: `${late}: its turn ended without its result, and the agent may still be at work on its thread`,
        reply: "",
      };
    }
    return {
      ending: "stopped" as const,
      detail: `${late}${stop === "stopped" ? "" : ", and its turn could not be stopped"}`,
      reply: "",
    };
  });
  const done = (round: number, produced: Schema.Json, said?: string) =>
    journaled(
      run,
      name,
      `agent/${name}/${round}/done`,
      Schema.Void,
      Effect.all(
        [
          run.store.stepEnded(run.runId, name, "completed", null),
          run.store.stepResult(run.runId, name, produced, said),
          run.store.runResumed(run.runId),
        ],
        { discard: true },
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
        start(`${round}`, options.brief, options.thread),
      ),
    );
    // Counted from the step's first turn, so corrections do not buy more time.
    const startedAt = turn.startedAt;
    let problem = turn.failed === undefined ? "" : `the agent could not be started: ${turn.failed}`;
    let stopped = false;
    let died = false;
    for (let correction = 0; turn.failed === undefined; correction++) {
      const result = yield* journaled(
        run,
        name,
        `agent/${name}/${round}/result/${correction}`,
        AgentResult,
        Effect.andThen(
          run.store.runStatus(run.runId, "waiting", `agent ${name}`),
          within(turn, startedAt),
        ),
      );
      if (result.ending !== "completed") {
        stopped = result.ending === "stopped";
        died = result.ending === "failed";
        problem = `the agent's turn was ${stopped ? "stopped" : "cut short"}: ${result.detail}`;
        break;
      }
      if (decodeOutput === undefined) {
        yield* done(round, result.reply);
        return { outcome: "done", value: result.reply as A, thread: threadOf(turn) };
      }
      const decoded =
        result.output === undefined
          ? Result.fail("it ended its turn without submitting a result")
          : yield* decodeOutput(result.output).pipe(
              Effect.mapError((error) => `its result no longer fits: ${text(error)}`),
              Effect.result,
            );
      if (Result.isSuccess(decoded)) {
        yield* done(round, result.output ?? null, result.reply);
        return { outcome: "done", value: decoded.success, thread: threadOf(turn) };
      }
      problem = `the agent did not return a result: ${decoded.failure}`;
      if (correction >= CORRECTIONS) break;
      // Back to the same thread: it has the context and only owes the result.
      const corrected = yield* journaled(
        run,
        name,
        `agent/${name}/${round}/correct/${correction}`,
        AgentTurn,
        start(
          `${round}/correct/${correction}`,
          "Your turn ended without a submitted result. Do not redo the work: call `t3_submit_output` now with the result of what you did.",
          threadOf(turn),
        ),
      );
      if (corrected.failed !== undefined) {
        problem = `${problem}, and it could not be asked again: ${corrected.failed}`;
        break;
      }
      turn = corrected;
    }
    // The turn may only be out of sight, not dead: it is stopped before another does its work again.
    // A stop that does not get through pauses the run unrecorded, or gives up a step that returns.
    let lingers = false;
    if (died && turn.failed === undefined) {
      const lost = turn;
      lingers = !(yield* journaled(
        run,
        name,
        `agent/${name}/${round}/stop`,
        Schema.Boolean,
        agents
          .interrupt({ ...threadOf(lost), turnId: lost.turnId })
          .pipe(
            Effect.retry({ times: 2 }),
            Effect.as(true),
            onFailure === "pause" ? identity : Effect.catch(() => Effect.succeed(false)),
          ),
      ));
      if (lingers) problem = `${problem}; its turn could not be stopped`;
    }
    // A turn that died is not the job's fault the first time: once more, on a thread of its own,
    // or on the same thread for a step that continues one, since only that thread has its project.
    // Anything else is not tried again behind a person's back: one they stopped, one that never
    // started, or one that did its work and would not give its result, which may have acted.
    if (round % 2 === 0 && died && !lingers) continue;
    if (onFailure === "return") {
      yield* journaled(
        run,
        name,
        `agent/${name}/${round}/failed`,
        Schema.Void,
        Effect.andThen(
          run.store.stepEnded(run.runId, name, "failed", problem),
          run.store.runResumed(run.runId),
        ),
      );
      return {
        outcome: "failed",
        reason: problem,
        ...(turn.failed === undefined ? { thread: threadOf(turn) } : {}),
      };
    }
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
      // Resuming starts the agent's job again from the top, which is a person's call.
      true,
    );
  }
});

const orPause = <A = string, I = string>(
  name: string,
  options: AgentOptions<A, I>,
): Effect.Effect<{ readonly value: A; readonly thread: AgentThread }, never, InRun> =>
  Effect.flatMap(Effect.orDie(attempt(name, options, "pause")), (result) =>
    result.outcome === "done"
      ? Effect.succeed({ value: result.value, thread: result.thread })
      : // `pause` never returns a failure: the step fails first, which pauses the run.
        Effect.die(new Error(`Agent step ${name} failed without pausing: ${result.reason}`)),
  );

/**
 * An agent doing one job in a thread a person can open. It returns data checked against `returns`,
 * or its last message without one. It starts a thread in `project`, in the linked `environment`
 * when one is named, or continues `thread` where that is. Past `timeout` it is stopped. A turn
 * that dies is tried once more, then the run pauses at this step.
 */
export const agent = Object.assign(orPause, {
  /**
   * For a workflow that decides for itself what a failed agent means: another model, another
   * machine, or stop. An agent that could not be started, died twice, ran out of time or never
   * gave its result comes back as `failed` with the reason, and the run goes on.
   */
  try: <A = string, I = string>(
    name: string,
    options: AgentOptions<A, I>,
  ): Effect.Effect<Attempt<A>, never, InRun> => Effect.orDie(attempt(name, options, "return")),
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
  never,
  InRun
> =>
  Effect.suspend(() => {
    checkOptions(`ask("${name}")`, options, ["title", "choices", "data", "timeout"]);
    return Effect.orDie(
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
      }),
    );
  });
