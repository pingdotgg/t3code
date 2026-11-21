import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { daily, every, Tick, webhook, WebhookRequest } from "./triggers.ts";
import { issues, pullRequests } from "./forgeApi.ts";
import { cancel, runs, signal, signalAll, start, store } from "./stepServices.ts";
import { invoke, skip, sleep, step, stop, title, wait, workflow } from "./workflow.ts";
import { type AgentResult, WorkflowAgentError, WorkflowAgents } from "./WorkflowAgents.ts";
import Migration0100 from "../persistence/Migrations/106_Workflows.ts";
import Migration0101 from "../persistence/Migrations/107_WorkflowTriggers.ts";
import Migration0102 from "../persistence/Migrations/108_WorkflowStepEnvironment.ts";
import Migration0103 from "../persistence/Migrations/109_WorkflowRunInput.ts";
import Migration0104 from "../persistence/Migrations/110_WorkflowStore.ts";
import Migration0105 from "../persistence/Migrations/111_WorkflowRunParent.ts";
import Migration0106 from "../persistence/Migrations/112_WorkflowStepResult.ts";
import Migration0107 from "../persistence/Migrations/113_WorkflowWaitWatch.ts";
import Migration0108 from "../persistence/Migrations/114_WorkflowStepTurn.ts";
import Migration0109 from "../persistence/Migrations/115_WorkflowRunKey.ts";
import * as WorkflowEngine from "./WorkflowEngine.ts";
import { Issue, unavailable, WorkflowForge, WorkflowForgeError } from "./WorkflowForge.ts";
import { agent, ask } from "./workflowAgent.ts";
import * as Workflows from "./Workflows.ts";
import * as WorkflowStore from "./WorkflowStore.ts";
import type { WorkflowRun, WorkflowRunStatus } from "./WorkflowStore.ts";

const once = { retry: { times: 0 } } as const;

/** Holds the `work` step of an `owned` run in `busy` mode until the test lets it go. */
interface Latch {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  readonly cleaned: Deferred.Deferred<void>;
}

/** A workflow whose `flaky` step fails until `failures` reaches zero, counting every execution. */
const definitions = (
  counts: Ref.Ref<Record<string, number>>,
  failures: Ref.Ref<number>,
  latch: Latch,
) => {
  const count = (name: string) =>
    Ref.updateAndGet(counts, (all) => ({ ...all, [name]: (all[name] ?? 0) + 1 })).pipe(
      Effect.map((all) => all[name]!),
    );
  return [
    workflow(
      "owned",
      {
        version: 1,
        payload: Schema.Struct({ mode: Schema.Literals(["finish", "stop", "hold", "busy"]) }),
        // Counted by how the run ended, and failing for as long as `failures` says.
        onEnd: (payload, end) =>
          Effect.gen(function* () {
            // The engine's setting for reading integers must not reach a cleanup either.
            if (yield* SqlClient.SafeIntegers) return yield* Effect.fail("SafeIntegers leaked");
            if (payload.mode === "busy") {
              // Says whether the step it cleans up after had finished.
              const all = yield* Ref.get(counts);
              yield* count(`end:busy:${all["work"] === 1 ? "after" : "before"} work`);
              return yield* Deferred.succeed(latch.cleaned, undefined);
            }
            const left = yield* Ref.getAndUpdate(failures, (rest) => Math.max(0, rest - 1));
            if (left > 0) return yield* Effect.fail("the machine would not go");
            yield* count(`end:${payload.mode}:${end.outcome}:${end.reason ?? ""}`);
          }),
      },
      (payload) =>
        Effect.gen(function* () {
          if (payload.mode === "busy") {
            yield* step(
              "work",
              { returns: Schema.Number },
              Effect.andThen(
                Effect.andThen(
                  Deferred.succeed(latch.entered, undefined),
                  Deferred.await(latch.release),
                ),
                count("work"),
              ),
            );
          }
          yield* step("take", { returns: Schema.Number, ...once }, count("take"));
          if (payload.mode === "stop") return yield* stop("no need");
          if (payload.mode === "hold") yield* wait("go", { returns: Schema.String });
        }),
    ),
    workflow(
      "flaky",
      {
        version: 1,
        payload: Schema.Struct({ id: Schema.String, settle: Schema.optional(Schema.Boolean) }),
        returns: Schema.String,
      },
      (payload) =>
        Effect.gen(function* () {
          if (payload.settle === true) {
            const tried = yield* step.try(
              "settled",
              { returns: Schema.Number },
              Effect.flatMap(
                Ref.getAndUpdate(failures, (left) => Math.max(0, left - 1)),
                (left) => (left > 0 ? Effect.fail("the dependency is down") : count("settled")),
              ),
            );
            return tried.outcome === "done" ? `settled ${tried.value}` : `gave up: ${tried.reason}`;
          }
          yield* step("before", { returns: Schema.Number, ...once }, count("before"));
          const attempt = yield* step(
            "flaky",
            { returns: Schema.Number, ...once },
            Effect.flatMap(
              Ref.getAndUpdate(failures, (left) => Math.max(0, left - 1)),
              (left) => (left > 0 ? Effect.fail("the dependency is down") : count("flaky")),
            ),
          );
          return `done on attempt ${attempt}`;
        }),
    ),
    workflow(
      "review",
      {
        version: 1,
        payload: Schema.Struct({ change: Schema.String, timeout: Schema.optional(Schema.String) }),
        returns: Schema.String,
      },
      (payload) =>
        Effect.gen(function* () {
          yield* title(`review of ${payload.change}`);
          yield* sleep("settle", "1 millis");
          const [a, b] = yield* Effect.all(
            [
              step("check/a", { returns: Schema.Number, ...once }, count("check/a")),
              step("check/b", { returns: Schema.Number, ...once }, count("check/b")),
            ],
            { concurrency: 2 },
          );
          const verdict = yield* wait("verdict", {
            returns: Schema.Struct({ merge: Schema.Boolean }),
            channel: payload.change,
            ...(payload.timeout === undefined ? {} : { timeout: "0 millis" }),
          });
          if (Option.isNone(verdict)) return yield* stop("nobody answered");
          yield* step("after", { returns: Schema.Number, ...once }, count("after"));
          return `${a + b} checks, merge: ${verdict.value.merge}`;
        }),
    ),
    /** Reads a number from text, which its JSON Schema cannot say: any string fits that. */
    workflow("reading", { version: 1, payload: Schema.Struct({}), returns: Schema.Number }, () =>
      Effect.map(
        wait("count", { returns: Schema.FiniteFromString }),
        Option.getOrElse(() => -1),
      ),
    ),
    workflow(
      "broken",
      { version: 1, payload: Schema.Struct({ how: Schema.Literals(["dies", "unstorable"]) }) },
      (payload) =>
        payload.how === "dies"
          ? step(
              "dies",
              { returns: Schema.Void, ...once },
              Effect.die(new Error("null dereference")),
            )
          : Effect.asVoid(
              step("unstorable", { returns: Schema.Int, ...once }, Effect.succeed(1.5)),
            ),
    ),
    workflow("twice", { version: 1, payload: Schema.Struct({}) }, () =>
      Effect.gen(function* () {
        yield* step("same", { returns: Schema.Void, ...once }, Effect.void);
        yield* step("same", { returns: Schema.Void, ...once }, Effect.void);
      }),
    ),
    workflow("reserved", { version: 1, payload: Schema.Struct({}) }, () =>
      step("onEnd", { returns: Schema.Void, ...once }, Effect.void),
    ),
    ...[1, 2].map((version) =>
      workflow("versioned", { version, payload: Schema.Struct({}), returns: Schema.Number }, () =>
        Effect.succeed(version),
      ),
    ),
  ];
};

/** Write a change, ask a person whether to merge it, then land it in the writer's own thread. */
const tally = store.entry("tally", Schema.Number);
const stored = [
  /** Counts itself in the store, with the first try of the step failing after it counted. */
  workflow(
    "tally",
    {
      version: 1,
      payload: Schema.Struct({ wrong: Schema.optional(Schema.Boolean) }),
      returns: Schema.Number,
    },
    (payload) =>
      payload.wrong === true
        ? step(
            "read",
            { returns: Schema.Number, ...once },
            Effect.as(store.entry("tally", Schema.String).get, 0),
          )
        : step(
            "count",
            { returns: Schema.Number, ...once },
            tally
              .update((current) => Option.getOrElse(current, () => 0) + 1)
              .pipe(Effect.map(Option.getOrElse(() => 0))),
          ),
  ),
  /** Waits in line for a door that `opener` opens. */
  workflow(
    "door",
    { version: 1, payload: Schema.Struct({ door: Schema.String }), returns: Schema.String },
    (payload) =>
      Effect.map(
        wait("open", { returns: Schema.String, channel: payload.door }),
        Option.getOrElse(() => "never"),
      ),
  ),
  workflow(
    "opener",
    { version: 1, payload: Schema.Struct({ door: Schema.String, fail: Schema.Boolean }) },
    (payload) =>
      step(
        "open",
        { returns: Schema.Void, retry: { times: 1 } },
        Effect.gen(function* () {
          // Written and taken back together when the step fails after writing.
          yield* store.transaction(
            Effect.gen(function* () {
              yield* store.entry(`doors/${payload.door}`, Schema.String).set("open");
              const tries = yield* store
                .entry(`tries/${payload.door}`, Schema.Number)
                .update((current) => Option.getOrElse(current, () => 0) + 1);
              if (payload.fail && Option.contains(tries, 1)) return yield* Effect.fail("slipped");
            }),
          );
          yield* signal({ workflow: "door", channel: payload.door }, "came in");
        }),
      ),
  ),
  /** Opens two doors, fails, and on its second try opens the second and a third. */
  workflow(
    "relay",
    { version: 1, payload: Schema.Struct({ doors: Schema.Array(Schema.String) }) },
    (payload) =>
      step(
        "pass",
        { returns: Schema.Void, retry: { times: 1 } },
        Effect.gen(function* () {
          const tries = yield* store
            .entry("relay-tries", Schema.Number)
            .update((current) => Option.getOrElse(current, () => 0) + 1);
          const [a, b, c] = payload.doors;
          const doors = Option.contains(tries, 1) ? [a!, b!] : [b!, c!];
          for (const door of doors) yield* signal({ workflow: "door", channel: door }, "came in");
          if (Option.contains(tries, 1)) return yield* Effect.fail("slipped");
        }),
      ),
  ),
];

const kid = workflow(
  "kid",
  {
    version: 1,
    payload: Schema.Struct({ mode: Schema.Literals(["finish", "stop", "hold"]) }),
    returns: Schema.String,
  },
  (payload) =>
    Effect.gen(function* () {
      if (payload.mode === "stop") return yield* stop("nothing to do");
      if (payload.mode === "hold") yield* wait("go", { returns: Schema.String });
      return "grown";
    }),
);
const family = [
  kid,
  /** Runs a kid as part of itself and reports how the kid ended. */
  workflow(
    "parent",
    {
      version: 1,
      payload: Schema.Struct({ mode: Schema.Literals(["finish", "stop", "hold"]) }),
      returns: Schema.String,
    },
    (payload) =>
      Effect.map(invoke("kid", kid, payload), (ended) =>
        ended.outcome === "completed" ? ended.value : `${ended.outcome}: ${ended.reason}`,
      ),
  ),
  /** Invokes under a name a step of its own already has. */
  workflow("clash", { version: 1, payload: Schema.Struct({}) }, () =>
    Effect.andThen(
      step("kid", { returns: Schema.Void, ...once }, Effect.void),
      invoke("kid", kid, { mode: "finish" }),
    ),
  ),
  /** Starts two kids and does not wait for them. */
  workflow(
    "spawner",
    { version: 1, payload: Schema.Struct({}), returns: Schema.Array(Schema.String) },
    () =>
      step(
        "spawn",
        { returns: Schema.Array(Schema.String), ...once },
        Effect.forEach(["one", "two"], (key) =>
          Effect.map(start(kid, { mode: "finish" }, { key: `spawned/${key}` }), (run) => run.runId),
        ),
      ),
  ),
  /** Two agents at once, the second with a minute to finish. */
  workflow("pair", { version: 1, payload: Schema.Struct({}), returns: Schema.String }, () =>
    Effect.map(
      Effect.all(
        [
          agent("left", { brief: "Left.", project: "p1" }),
          agent("right", { brief: "Right.", project: "p1", timeout: "1 minute" }),
        ],
        { concurrency: 2 },
      ),
      ([left, right]) => `${left.value} ${right.value}`,
    ),
  ),
];

const fix = workflow(
  "fix",
  {
    version: 1,
    payload: Schema.Struct({
      project: Schema.String,
      environment: Schema.optional(Schema.String),
      // Lands with a model of its own, which a continued thread cannot take.
      reshape: Schema.optional(Schema.Boolean),
    }),
    returns: Schema.String,
  },
  (payload) =>
    Effect.gen(function* () {
      const written = yield* agent("write", {
        brief: "Write the fix.",
        project: payload.project,
        ...(payload.environment === undefined ? {} : { environment: payload.environment }),
        returns: Schema.Struct({ branch: Schema.String }),
      });
      const answer = yield* ask("merge", {
        title: `Merge ${written.value.branch}?`,
        choices: ["Merge", "Leave"],
        data: { branch: written.value.branch },
      });
      if (Option.isNone(answer) || answer.value.choice !== "Merge") return yield* stop("left");
      const landed = yield* agent("land", {
        brief: "Land it.",
        thread: written.thread,
        ...(payload.reshape === true ? { model: { instanceId: "codex", model: "gpt" } } : {}),
      });
      return `${written.value.branch}: ${landed.value}`;
    }),
);

/** Waits at a gate with others, until whoever keeps it lets everyone through. */
const gate = workflow(
  "gate",
  { version: 1, payload: Schema.Struct({ gate: Schema.String }), returns: Schema.String },
  (payload) =>
    Effect.map(
      wait("through", { returns: Schema.String, channel: payload.gate }),
      Option.getOrElse(() => "never"),
    ),
);
const control = [
  gate,
  /** Looks at the runs at the gates, lets one gate's through, or sends one run away. */
  workflow(
    "keeper",
    {
      version: 1,
      payload: Schema.Struct({ act: Schema.Literals(["look", "open", "dismiss", "leave"]) }),
      returns: Schema.Json,
    },
    (payload, run) =>
      step(
        "act",
        { returns: Schema.Json, ...once },
        Effect.gen(function* () {
          const waiting = yield* runs({ workflow: gate, keyPrefix: "visit/" });
          if (payload.act === "open") return yield* signalAll({ channel: "north" }, "go on");
          if (payload.act === "leave") return yield* Effect.as(cancel(run.id, "done here"), null);
          if (payload.act === "dismiss") {
            const last = waiting.find((visit) => visit.key === "visit/3");
            return yield* Effect.as(cancel(last?.id ?? "", "the gate is closed"), null);
          }
          return waiting.map((visit) => `${visit.key} ${visit.status}`).toSorted();
        }),
      ),
  ),
  /** Gives the job to a second agent when the first one fails, and says how it went. */
  workflow(
    "fallback",
    {
      version: 1,
      payload: Schema.Struct({
        project: Schema.String,
        timeout: Schema.optional(Schema.Literal("1 minute")),
        /** Says which thread the first agent's failure came back with. */
        thread: Schema.optional(Schema.Boolean),
      }),
      returns: Schema.String,
    },
    (payload) =>
      Effect.gen(function* () {
        const output = Schema.Struct({ head: Schema.String });
        const first = yield* agent.try("first", {
          brief: "Fix it.",
          project: payload.project,
          returns: output,
          ...(payload.timeout === undefined ? {} : { timeout: payload.timeout }),
        });
        if (first.outcome === "done") return first.value.head;
        const second = yield* agent.try("second", {
          brief: "Fix it.",
          project: "p1",
          returns: output,
        });
        if (second.outcome === "failed") return yield* stop(second.reason);
        const where = payload.thread === true ? ` in ${first.thread?.threadId ?? "no thread"}` : "";
        return `${second.value.head} after: ${first.reason}${where}`;
      }),
  ),
];

type Started = Parameters<WorkflowAgents["Service"]["start"]>[0];

/** Agents the test plays: it sees each turn start and decides how that turn ends. */
const fakeAgents = () => {
  const turns = new Map<
    string,
    { started: Deferred.Deferred<Started>; ended: Deferred.Deferred<AgentResult> }
  >();
  const interrupted: Array<{
    readonly threadId: string;
    readonly environment?: string | undefined;
    readonly turnId?: string | undefined;
  }> = [];
  let threads = 0;
  let refusals = 0;
  const unreadable = new Set<string>();
  const unanswered = new Set<string>();
  const unstartable = new Set<string>();
  const turn = (key: string) => {
    const known = turns.get(key);
    if (known !== undefined) return known;
    const made = {
      started: Deferred.makeUnsafe<Started>(),
      ended: Deferred.makeUnsafe<AgentResult>(),
    };
    turns.set(key, made);
    return made;
  };
  return {
    service: WorkflowAgents.of({
      start: (input) =>
        Effect.gen(function* () {
          // The engine's own setting for reading integers must not reach what a step calls.
          if (yield* SqlClient.SafeIntegers) {
            return yield* new WorkflowAgentError({ reason: "SafeIntegers leaked into a step" });
          }
          if (input.project === "nowhere" || unstartable.delete(input.key)) {
            return yield* new WorkflowAgentError({ reason: "No project is registered there." });
          }
          yield* Deferred.succeed(turn(input.key).started, input);
          return {
            threadId: input.thread ?? `thread-${++threads}`,
            turnId: input.key,
            ...(input.environment === undefined ? {} : { environment: input.environment }),
          };
        }),
      result: (started) => {
        const once = (keys: Set<string>) =>
          [...keys].some((key) => started.turnId.endsWith(`/${key}`) && keys.delete(key));
        if (once(unreadable)) {
          return Effect.fail(new WorkflowAgentError({ reason: "the result could not be read" }));
        }
        return once(unanswered) ? Effect.never : Deferred.await(turn(started.turnId).ended);
      },
      // Counted per try, so a retry of the same stop uses up a refusal too.
      interrupt: (thread) =>
        Effect.gen(function* () {
          if (yield* SqlClient.SafeIntegers) {
            return yield* new WorkflowAgentError({ reason: "SafeIntegers leaked into a stop" });
          }
          if (refusals-- > 0) return yield* new WorkflowAgentError({ reason: "the link is down" });
          interrupted.push(thread);
          const ended =
            thread.turnId !== undefined && turns.has(thread.turnId)
              ? yield* Deferred.isDone(turns.get(thread.turnId)!.ended)
              : false;
          return ended ? ("ended" as const) : ("stopped" as const);
        }),
    }),
    interrupted,
    /** The next read of a turn with this key fails. */
    unreadableResult: (key: string) => {
      unreadable.add(key);
    },
    /** The next read of a turn with this key never answers, as one that is waited past. */
    unansweredResult: (key: string) => {
      unanswered.add(key);
    },
    /** The turn of `runId` with this key cannot be started. */
    unstartable: (runId: string, key: string) => {
      unstartable.add(`${runId}/${key}`);
    },
    /** Turns down the next `count` stops. */
    refuseStops: (count: number) => {
      refusals = count;
    },
    /** The turn of `runId` with this key, once it has been started. */
    started: (runId: string, key: string) => Deferred.await(turn(`${runId}/${key}`).started),
    end: (runId: string, key: string, result: Partial<AgentResult>) =>
      Deferred.succeed(turn(`${runId}/${key}`).ended, {
        ending: "completed" as const,
        detail: "",
        reply: "",
        ...result,
      }),
  };
};

/** While set, `nightly` turns down every tick, so its start fails. */
const ticks = { refused: false };
const triggered = [
  workflow(
    "nightly",
    {
      version: 1,
      payload: Tick.check(Schema.makeFilter(() => !ticks.refused || "not now")),
      returns: Schema.String,
      triggers: [every("1 hour")],
    },
    (tick) => Effect.succeed(tick.scheduledAt),
  ),
  workflow(
    "morning",
    { version: 1, payload: Tick, triggers: [daily("09:00", { weekdays: [1, 2, 3, 4, 5] })] },
    () => Effect.void,
  ),
  workflow(
    "inbound",
    {
      version: 1,
      payload: WebhookRequest,
      triggers: [
        webhook("push", {
          key: (request) =>
            request.headers["x-delivery"] ??
            (JSON.parse(request.body) as { readonly delivery?: string }).delivery,
        }),
      ],
    },
    (request) => (request.body === "ping" ? skip("only a ping") : Effect.succeed(request.body)),
  ),
];

const PROJECT = "/home/me/app";
const triage = workflow(
  "triage",
  {
    version: 1,
    payload: Issue,
    returns: Schema.String,
    triggers: [issues.opened({ project: PROJECT, labels: ["bug"] })],
  },
  Effect.fn(function* (issue) {
    yield* step(
      "thank",
      { returns: Schema.Void },
      issues.comment(issue, `Looking at ${issue.title}.`),
    );
    return issue.displayKey;
  }),
);
const decodeIssue = Schema.decodeSync(Issue);
const land = workflow(
  "land",
  { version: 1, payload: Schema.Struct({ url: Schema.String }), returns: Schema.String },
  Effect.fn(function* (payload) {
    const standing = yield* pullRequests.wait(
      "checks",
      { project: PROJECT, url: payload.url },
      { until: "checks", timeout: "1 hour" },
    );
    return Option.match(standing, { onNone: () => "gave up", onSome: (at) => at.checks });
  }),
);
const issueAt = (key: string, createdAt: string) =>
  decodeIssue({
    projectId: "project-1",
    projectTitle: "app",
    tracker: "github",
    host: "github.com",
    scope: "me/app",
    key,
    displayKey: `#${key}`,
    title: `Issue ${key}`,
    url: `https://github.com/me/app/issues/${key}`,
    author: null,
    state: { name: "open", category: "open" },
    createdAt,
    updatedAt: createdAt,
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
  });
/** A tracker that lists what the test put in it and remembers what was said. */
// The real trackers read the server's own tables, which do not decode under the engine's BigInts.
const asTheServerReads = <A>(answer: () => A) =>
  Effect.flatMap(SqlClient.SafeIntegers, (bigInts) =>
    bigInts
      ? Effect.fail(new WorkflowForgeError({ reason: "called with the engine's BigInts on" }))
      : Effect.sync(answer),
  );

const fakeForge = () => {
  const open: Array<Issue> = [];
  const asked: Array<Parameters<WorkflowForge["Service"]["issues"]["list"]>[0]> = [];
  const comments: Array<string> = [];
  const pullRequest = {
    state: "open",
    mergeability: "mergeable",
    url: "https://github.com/me/app/pull/7",
    checks: [{ name: "test", status: "pending", description: null, url: null }],
  };
  return {
    open,
    asked,
    comments,
    pullRequest,
    service: WorkflowForge.of({
      ...unavailable,
      pullRequests: {
        ...unavailable.pullRequests,
        // Only what a wait looks at; the rest of a pull request is the host's business.
        read: () => asTheServerReads(() => structuredClone(pullRequest) as never),
      },
      issues: {
        ...unavailable.issues,
        list: (query) =>
          asTheServerReads(() => {
            asked.push(query);
            return open;
          }),
        comment: (issue, body) =>
          asTheServerReads(
            () => void comments.push(`${"key" in issue ? issue.key : issue.url}: ${body}`),
          ),
      },
    }),
  };
};

const harness = Effect.fnUntraced(function* (store?: typeof WorkflowStore.layer) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workflows-" });
  const database = NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") });
  yield* Effect.provide(
    Effect.all(
      [
        Migration0100,
        Migration0101,
        Migration0102,
        Migration0103,
        Migration0104,
        Migration0105,
        Migration0106,
        Migration0107,
        Migration0108,
        Migration0109,
      ],
      {
        discard: true,
      },
    ),
    database,
  );
  const counts = yield* Ref.make<Record<string, number>>({});
  const failures = yield* Ref.make(0);
  const latch: Latch = {
    entered: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
    cleaned: yield* Deferred.make<void>(),
  };
  // One database file, so a second engine built from it is the server after a restart.
  const agents = fakeAgents();
  const forge = fakeForge();
  const engine = WorkflowEngine.layer(
    [
      triage,
      land,
      ...definitions(counts, failures, latch),
      fix,
      ...triggered,
      ...stored,
      ...family,
      ...control,
    ],
    store,
  ).pipe(
    Layer.provide(Layer.succeed(WorkflowAgents, agents.service)),
    Layer.provide(Layer.succeed(WorkflowForge, forge.service)),
    Layer.provide(database),
    Layer.provide(NodeCrypto.layer),
  );
  // The engine polls its message store, backs off between retries and bounds its shutdown, all
  // on the clock, so time runs for as long as a server is up, shutdown included. A test closes
  // `clock` to hold time still until it has seen what it waits for.
  const clock = yield* Latch.make(true);
  const boot = <A, E>(use: Effect.Effect<A, E, Workflows.Workflows>) =>
    Effect.raceFirst(
      Effect.scoped(Effect.provide(use, engine)),
      Effect.forever(Effect.andThen(clock.await, TestClock.adjust("1 second"))),
    );
  return { counts, failures, latch, boot, agents, forge, clock };
});

/** The store the engine writes to, for a test to leave what a crash would have left. */
const exposedStore = () => {
  const made = Deferred.makeUnsafe<WorkflowStore.WorkflowStore["Service"]>();
  return {
    layer: Layer.effect(
      WorkflowStore.WorkflowStore,
      Effect.tap(WorkflowStore.make, (store) => Deferred.succeed(made, store)),
    ),
    store: Deferred.await(made),
  };
};

/** The review workflow sleeps first, which is waiting too; this is its wait for a verdict. */
const atVerdict = (run: WorkflowRun) => run.status === "waiting" && run.detail === "verdict";
const status =
  (...statuses: ReadonlyArray<WorkflowRunStatus>) =>
  (run: WorkflowRun) =>
    statuses.includes(run.status);

it.effect(
  "a failing step pauses its run, and resuming runs that step again and nothing before it",
  () =>
    Effect.gen(function* () {
      const { counts, failures, boot } = yield* harness();
      yield* Ref.set(failures, 2);
      const runId = yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const { runId } = yield* workflows.start("flaky", { id: "a" }, { idempotencyKey: "a" });
          const again = yield* workflows.start("flaky", { id: "a" }, { idempotencyKey: "a" });
          assert.equal(again.runId, runId);

          const paused = yield* workflows.waitFor(runId, status("paused"));
          assert.include(paused.detail ?? "", "the dependency is down");
          assert.equal(paused.pauses, 1);
          // It says when it tries again by itself, which is after it paused.
          assert.isTrue(paused.resumesAt !== null && paused.resumesAt > paused.updatedAt);

          yield* workflows.resume(runId);
          const pausedAgain = yield* workflows.waitFor(runId, (run) => run.pauses === 2);
          assert.equal(pausedAgain.status, "paused");
          return runId;
        }),
      );

      // The server restarts while the run is paused. Nothing retries it until it is resumed.
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          assert.equal((yield* workflows.get(runId)).run.status, "paused");
          yield* workflows.resume(runId);
          const done = yield* workflows.waitFor(runId, status("completed"));
          assert.equal(done.result, "done on attempt 1");
          assert.equal(done.pauses, 0);
          const { steps } = yield* workflows.get(runId);
          assert.deepStrictEqual(
            steps.map((step) => [step.name, step.status, step.attempts]),
            [
              ["before", "completed", 1],
              ["flaky", "completed", 3],
            ],
          );
        }),
      );
      assert.deepStrictEqual(yield* Ref.get(counts), { before: 1, flaky: 1 });

      // `step.try` hands the failure to the workflow instead of pausing, and runs once by default.
      yield* Ref.set(failures, 1);
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const { runId } = yield* workflows.start(
            "flaky",
            { id: "b", settle: true },
            { idempotencyKey: "b" },
          );
          const done = yield* workflows.waitFor(runId, status("completed"));
          assert.equal(done.result, "gave up: the dependency is down");
          assert.equal(done.pauses, 0);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a wait survives a restart, checks what it is signalled with, and steps run once", () =>
  Effect.gen(function* () {
    const { counts, boot } = yield* harness();
    const runId = yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const { runId } = yield* workflows.start(
          "review",
          { change: "c1" },
          { idempotencyKey: "c1" },
        );
        const waiting = yield* workflows.waitFor(runId, atVerdict);
        assert.equal(waiting.title, "review of c1");
        // The sleep before the wait is a step a person can see.
        const slept = (yield* workflows.get(runId)).steps.find((step) => step.name === "settle");
        assert.deepStrictEqual([slept?.kind, slept?.status], ["sleep", "completed"]);
        const wrong = yield* workflows
          .signal({ runId, wait: "verdict" }, { merge: "yes" }, { id: "s0" })
          .pipe(Effect.flip);
        assert.include(wrong.message, "merge");
        return runId;
      }),
    );
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        // Addressed by key: the sender knows the change, not the run.
        assert.equal(
          yield* workflows.signal(
            { workflow: "review", channel: "c1" },
            { merge: true },
            { id: "s1" },
          ),
          "delivered",
        );
        const done = yield* workflows.waitFor(runId, status("completed"));
        assert.equal(done.result, "2 checks, merge: true");
      }),
    );
    assert.deepStrictEqual(yield* Ref.get(counts), { "check/a": 1, "check/b": 1, after: 1 });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a signal its wait cannot read leaves the wait open for one it can", () =>
  Effect.gen(function* () {
    const { boot } = yield* harness();
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const { runId } = yield* workflows.start("reading", {}, { idempotencyKey: "t1" });
        yield* workflows.waitFor(runId, status("waiting"));
        yield* workflows.signal({ runId, wait: "count" }, "many", { id: "t-many" });
        // Delivered straight or kept until the wait opens again: either way it is read.
        yield* workflows.signal({ runId, wait: "count" }, "5", { id: "t-5" });
        const done = yield* workflows.waitFor(runId, status("completed", "paused"));
        assert.deepStrictEqual([done.status, done.result], ["completed", 5]);
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a signal sent before its wait opens is delivered when it does", () =>
  Effect.gen(function* () {
    const { boot } = yield* harness();
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        assert.equal(
          yield* workflows.signal(
            { workflow: "review", channel: "c2" },
            { merge: false },
            { id: "s2" },
          ),
          "buffered",
        );
        const { runId } = yield* workflows.start(
          "review",
          { change: "c2" },
          { idempotencyKey: "c2" },
        );
        const done = yield* workflows.waitFor(runId, status("completed"));
        assert.equal(done.result, "2 checks, merge: false");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a signal buffered as its wait opens is still delivered to that wait", () =>
  Effect.gen(function* () {
    const looked = yield* Deferred.make<void>();
    const opened = yield* Deferred.make<void>();
    const checked = yield* Deferred.make<void>();
    // Holds the signal between finding no wait and buffering, while the wait opens and finds no mail.
    const store = Layer.effect(
      WorkflowStore.WorkflowStore,
      Effect.gen(function* () {
        const real = yield* WorkflowStore.make;
        let first = true;
        return WorkflowStore.WorkflowStore.of({
          ...real,
          waitAt: (address) =>
            Effect.tap(real.waitAt(address), () => {
              if (!("channel" in address) || address.channel !== "c9" || !first) return Effect.void;
              first = false;
              return Effect.andThen(Deferred.succeed(looked, undefined), Deferred.await(opened));
            }),
          mailNext: (addresses, passed) =>
            Effect.tap(real.mailNext(addresses, passed), (mail) =>
              mail === undefined && !first ? Deferred.succeed(checked, undefined) : Effect.void,
            ),
        });
      }),
    );
    const { boot } = yield* harness(store);
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const sent = yield* Effect.forkChild(
          workflows.signal({ workflow: "review", channel: "c9" }, { merge: true }, { id: "s9" }),
        );
        yield* Deferred.await(looked);
        const { runId } = yield* workflows.start(
          "review",
          { change: "c9" },
          { idempotencyKey: "c9" },
        );
        // Released once the open wait has looked for mail and found none.
        yield* Deferred.await(checked);
        yield* Deferred.succeed(opened, undefined);
        assert.equal(yield* Fiber.join(sent), "delivered");
        const done = yield* workflows.waitFor(runId, status("completed"));
        assert.equal(done.result, "2 checks, merge: true");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a wait another signal claimed first wakes with that signal's value", () =>
  Effect.gen(function* () {
    // A second signal claims the wait just before the early mail is handed to it.
    const store = Layer.effect(
      WorkflowStore.WorkflowStore,
      Effect.gen(function* () {
        const real = yield* WorkflowStore.make;
        return WorkflowStore.WorkflowStore.of({
          ...real,
          mailDeliver: (signalId, runId, name, woke) =>
            Effect.andThen(
              real.waitSignalled(runId, name, { expired: false, value: { merge: true } }),
              real.mailDeliver(signalId, runId, name, woke),
            ),
        });
      }),
    );
    const { boot } = yield* harness(store);
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        assert.equal(
          yield* workflows.signal(
            { workflow: "review", channel: "c8" },
            { merge: false },
            { id: "s8" },
          ),
          "buffered",
        );
        const { runId } = yield* workflows.start(
          "review",
          { change: "c8" },
          { idempotencyKey: "c8" },
        );
        const done = yield* workflows.waitFor(runId, status("completed"));
        assert.equal(done.result, "2 checks, merge: true");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a wait past its timeout wakes with nothing, and a workflow may stop on its own", () =>
  Effect.gen(function* () {
    const { boot } = yield* harness();
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const { runId } = yield* workflows.start(
          "review",
          { change: "c3", timeout: "now" },
          { idempotencyKey: "c3" },
        );
        yield* workflows.waitFor(runId, atVerdict);
        yield* workflows.sweep;
        const stopped = yield* workflows.waitFor(runId, status("stopped"));
        assert.equal(stopped.detail, "nobody answered");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a cancelled run ends, and two steps with one name pause their run", () =>
  Effect.gen(function* () {
    // The start of `v3` is cut off once its row is written, before the engine has it.
    const cutOff = new Set(["v3"]);
    const store = Layer.effect(
      WorkflowStore.WorkflowStore,
      Effect.map(WorkflowStore.make, (real) =>
        WorkflowStore.WorkflowStore.of({
          ...real,
          runStarted: (run) =>
            Effect.tap(real.runStarted(run), () =>
              cutOff.delete(run.idempotencyKey) ? Effect.die("the server stopped") : Effect.void,
            ),
        }),
      ),
    );
    const { boot } = yield* harness(store);
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const waiting = yield* workflows.start(
          "review",
          { change: "c4" },
          { idempotencyKey: "c4" },
        );
        yield* workflows.waitFor(waiting.runId, atVerdict);
        yield* workflows.cancel(waiting.runId, "not needed");
        const cancelled = (yield* workflows.get(waiting.runId)).run;
        assert.equal(cancelled.status, "cancelled");
        assert.equal(cancelled.detail, "not needed");
        // A cancel with no reason gives none, rather than repeating that the run was cancelled.
        const unexplained = yield* workflows.start(
          "review",
          { change: "c5" },
          { idempotencyKey: "c5" },
        );
        yield* workflows.waitFor(unexplained.runId, atVerdict);
        yield* workflows.cancel(unexplained.runId);
        assert.equal((yield* workflows.get(unexplained.runId)).run.detail, null);
        // A signal for the wait it had is kept as mail, not delivered to a run that ended.
        assert.equal(
          yield* workflows.signal(
            { runId: waiting.runId, wait: "verdict" },
            { merge: true },
            { id: "s4" },
          ),
          "buffered",
        );
        // A file written for the old `title(name, text)` is refused, not titled with the name.
        assert.throws(
          () => (title as (...args: ReadonlyArray<string>) => unknown)("name", "Release v1"),
          /takes only the text/,
        );

        const twice = yield* workflows.start("twice", {}, { idempotencyKey: "t1" });
        const paused = yield* workflows.waitFor(twice.runId, status("paused"));
        assert.include(paused.detail ?? "", 'named "same"');
        // The cleanup step's name is taken by nothing else.
        const reserved = yield* workflows.start("reserved", {}, { idempotencyKey: "r1" });
        const refusedName = yield* workflows.waitFor(reserved.runId, status("paused"));
        assert.include(refusedName.detail ?? "", "cleanup step");

        const missing = yield* workflows
          .start("nothing", {}, { idempotencyKey: "n1" })
          .pipe(Effect.flip);
        assert.equal(missing._tag, "WorkflowNotRegisteredError");
        // A version asked for by name is that version or nothing, never the latest instead.
        const unknownVersion = yield* workflows
          .start("twice", {}, { idempotencyKey: "t2", version: 2 })
          .pipe(Effect.flip);
        assert.equal(unknownVersion.message, "Version 2 of workflow twice is not registered.");
        const older = yield* workflows.start("versioned", {}, { idempotencyKey: "v1", version: 1 });
        const latest = yield* workflows.start("versioned", {}, { idempotencyKey: "v2" });
        assert.equal((yield* workflows.waitFor(older.runId, status("completed"))).result, 1);
        assert.equal((yield* workflows.waitFor(latest.runId, status("completed"))).result, 2);
        // A key is one run of the workflow, whichever version starts it again.
        assert.deepStrictEqual(
          yield* workflows.start("versioned", {}, { idempotencyKey: "v1" }),
          older,
        );
        // A start cut off between its row and the engine is executed by the next start.
        const cut = yield* Effect.exit(
          workflows.start("versioned", {}, { idempotencyKey: "v3", version: 1 }),
        );
        assert.isTrue(Exit.isFailure(cut));
        const again = yield* workflows.start("versioned", {}, { idempotencyKey: "v3" });
        assert.equal((yield* workflows.waitFor(again.runId, status("completed"))).result, 1);
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "an agent returns checked data, a person answers, and a later step continues the thread",
  () =>
    Effect.gen(function* () {
      let kept: WorkflowStore.WorkflowStore["Service"] | undefined;
      const store = Layer.effect(
        WorkflowStore.WorkflowStore,
        Effect.tap(WorkflowStore.make, (real) => Effect.sync(() => void (kept = real))),
      );
      const { boot, agents } = yield* harness(store);
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const { runId } = yield* workflows.start(
            "fix",
            { project: "p1" },
            { idempotencyKey: "f1" },
          );

          const write = yield* agents.started(runId, "write/0");
          assert.equal(write.project, "p1");
          assert.equal(write.thread, undefined);
          assert.deepStrictEqual(write.outputSchema?.required, ["branch"]);
          // It ended its turn without a result: the same thread is asked for it, not for the work.
          yield* agents.end(runId, "write/0", { reply: "done" });
          const correction = yield* agents.started(runId, "write/0/correct/0");
          assert.equal(correction.thread, "thread-1");
          yield* agents.end(runId, "write/0/correct/0", {
            output: { branch: "fix/1" },
            reply: "Pushed fix/1.",
          });

          yield* workflows.waitFor(runId, (run) => run.detail === "merge");
          // A person reads what the agent said beside the data it returned.
          const written = (yield* workflows.get(runId)).steps.find((step) => step.name === "write");
          assert.deepStrictEqual(
            [written?.result, written?.said],
            [{ branch: "fix/1" }, "Pushed fix/1."],
          );
          const [question] = yield* workflows.questions;
          // The agent whose work raised the question is one click from it.
          assert.deepStrictEqual(question?.thread, { threadId: "thread-1", environmentId: null });
          assert.deepStrictEqual(question?.request, {
            title: "Merge fix/1?",
            choices: ["Merge", "Leave"],
            data: { branch: "fix/1" },
          });
          const refused = yield* workflows
            .signal({ runId, wait: "merge" }, { choice: "Maybe" }, { id: "a0" })
            .pipe(Effect.flip);
          assert.include(refused.message, "merge waits for");
          // Clicked twice: one answer, and nothing kept to answer it again.
          yield* Effect.all(
            [
              workflows.answer(runId, "merge", { choice: "Merge" }),
              workflows.answer(runId, "merge", { choice: "Merge" }),
            ],
            { concurrency: "unbounded" },
          );
          yield* workflows.answer(runId, "merge", { choice: "Leave" });
          assert.isUndefined(yield* kept!.mailNext([{ runId, wait: "merge" }]));

          const land = yield* agents.started(runId, "land/0");
          assert.equal(land.thread, "thread-1");
          assert.equal(land.outputSchema, undefined);
          yield* agents.end(runId, "land/0", { reply: "merged as abc123" });
          const done = yield* workflows.waitFor(runId, status("completed"));
          assert.equal(done.result, "fix/1: merged as abc123");
          assert.deepStrictEqual(yield* workflows.questions, []);
          // Each step keeps what it produced, for a person reading the run afterwards.
          const { steps } = yield* workflows.get(runId);
          assert.deepStrictEqual(
            steps.map((step) => [step.name, step.result]),
            [
              ["write", { branch: "fix/1" }],
              ["merge", { choice: "Merge" }],
              ["land", "merged as abc123"],
            ],
          );
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "an agent whose turn dies is tried on a new thread, then its run pauses until resumed",
  () =>
    Effect.gen(function* () {
      const exposed = exposedStore();
      const { boot, agents } = yield* harness(exposed.layer);
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const { runId } = yield* workflows.start(
            "fix",
            { project: "p1" },
            { idempotencyKey: "f2" },
          );
          yield* agents.started(runId, "write/0");
          // Its turn is stopped before the next one starts; a stop that fails pauses the run.
          agents.refuseStops(3);
          yield* agents.end(runId, "write/0", { ending: "failed", detail: "failed" });
          const refused = yield* workflows.waitFor(runId, status("paused"));
          assert.include(refused.detail ?? "", "the link is down");
          // A stop that did not get through is tried again by itself.
          assert.isNotNull(refused.resumesAt);
          assert.equal(agents.interrupted.length, 0);
          yield* agents.started(runId, "write/1");
          assert.equal(agents.interrupted.length, 1);
          yield* agents.end(runId, "write/1", { ending: "failed", detail: "provider error" });

          const paused = yield* workflows.waitFor(runId, status("paused"));
          assert.include(paused.detail ?? "", "provider error");
          // An agent that gave up starts its whole job again on resume: a person decides that.
          assert.isNull(paused.resumesAt);
          // A resume cut off before it reached the engine is put back by the sweep, still held.
          yield* (yield* exposed.store).runUnpaused(runId);
          const putBack = yield* workflows.waitFor(runId, status("paused"));
          assert.deepStrictEqual([putBack.status, putBack.resumesAt], ["paused", null]);
          yield* workflows.resume(runId);
          yield* agents.started(runId, "write/2");
          yield* agents.end(runId, "write/2", { output: { branch: "fix/2" } });
          yield* workflows.waitFor(runId, (run) => run.detail === "merge");
          yield* workflows.signal({ runId, wait: "merge" }, { choice: "Leave" }, { id: "a2" });
          const stopped = yield* workflows.waitFor(runId, status("stopped"));
          assert.equal(stopped.detail, "left");
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "a step that dies, or whose result cannot be stored, pauses its run like any failure",
  () =>
    Effect.gen(function* () {
      const { boot } = yield* harness();
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const dies = yield* workflows.start("broken", { how: "dies" }, { idempotencyKey: "b1" });
          const died = yield* workflows.waitFor(dies.runId, status("paused"));
          assert.include(died.detail ?? "", "null dereference");
          const unstorable = yield* workflows.start(
            "broken",
            { how: "unstorable" },
            { idempotencyKey: "b2" },
          );
          const refused = yield* workflows.waitFor(unstorable.runId, status("paused"));
          assert.include(refused.detail ?? "", "unstorable");
          assert.equal((yield* workflows.get(unstorable.runId)).steps[0]?.status, "failed");
          // Never marked done on the way, so each try counts as one more pause.
          yield* workflows.waitFor(unstorable.runId, (run) => run.pauses >= 2);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "signals: one per wait, a retried id is not a second one, and early mail a wait cannot read is kept",
  () =>
    Effect.gen(function* () {
      let kept: WorkflowStore.WorkflowStore["Service"] | undefined;
      const store = Layer.effect(
        WorkflowStore.WorkflowStore,
        Effect.tap(WorkflowStore.make, (real) => Effect.sync(() => void (kept = real))),
      );
      const { boot } = yield* harness(store);
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const key = { workflow: "review", channel: "k1" };
          // Two signals before any run waits: the first is not what the wait expects.
          yield* workflows.signal(key, { merge: "x" }, { id: "bad" });
          yield* workflows.signal(key, { merge: true }, { id: "good" });
          const first = yield* workflows.start(
            "review",
            { change: "k1" },
            { idempotencyKey: "k1a" },
          );
          const done = yield* workflows.waitFor(first.runId, status("completed"));
          assert.equal(done.result, "2 checks, merge: true");
          // Left for whichever wait on the channel reads it, another version's perhaps.
          assert.equal((yield* kept!.mailNext([key]))?.signalId, "bad");
          // The sender retries the signal that was already delivered from the mail.
          assert.equal(yield* workflows.signal(key, { merge: true }, { id: "good" }), "delivered");

          const second = yield* workflows.start(
            "review",
            { change: "k1" },
            { idempotencyKey: "k1b" },
          );
          const third = yield* workflows.start(
            "review",
            { change: "k1" },
            { idempotencyKey: "k1c" },
          );
          yield* workflows.waitFor(second.runId, atVerdict);
          yield* workflows.waitFor(third.runId, atVerdict);
          // Nothing was left over for them, and each new signal wakes one run.
          assert.equal(yield* workflows.signal(key, { merge: false }, { id: "s1" }), "delivered");
          assert.equal(yield* workflows.signal(key, { merge: true }, { id: "s2" }), "delivered");
          const results = [
            (yield* workflows.waitFor(second.runId, status("completed"))).result,
            (yield* workflows.waitFor(third.runId, status("completed"))).result,
          ];
          // Each new signal woke one of the two runs, whichever opened its wait first.
          assert.sameMembers(
            results.map((result) => String(result).split(", ")[1]),
            ["merge: false", "merge: true"],
          );
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("signals that race for the waits on one channel each wake one of them", () =>
  Effect.gen(function* () {
    // All three senders look before any claims, and the two that lose look again together.
    const barriers = [
      { at: 3, all: Deferred.makeUnsafe<void>() },
      { at: 5, all: Deferred.makeUnsafe<void>() },
    ];
    let looked = 0;
    const store = Layer.effect(
      WorkflowStore.WorkflowStore,
      Effect.map(WorkflowStore.make, (real) =>
        WorkflowStore.WorkflowStore.of({
          ...real,
          waitAt: (address) =>
            Effect.tap(real.waitAt(address), () => {
              if (!("channel" in address) || address.channel !== "k3") return Effect.void;
              const at = ++looked;
              const barrier = barriers.find((candidate) => at <= candidate.at);
              if (barrier === undefined) return Effect.void;
              return at === barrier.at
                ? Deferred.succeed(barrier.all, undefined)
                : Deferred.await(barrier.all);
            }),
        }),
      ),
    );
    const { boot } = yield* harness(store);
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const runs = yield* Effect.forEach(["k3a", "k3b", "k3c"], (key) =>
          workflows.start("review", { change: "k3" }, { idempotencyKey: key }),
        );
        yield* Effect.forEach(runs, (run) => workflows.waitFor(run.runId, atVerdict));
        const sent = yield* Effect.forEach(
          ["r1", "r2", "r3"],
          (id) => workflows.signal({ workflow: "review", channel: "k3" }, { merge: true }, { id }),
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(sent, ["delivered", "delivered", "delivered"]);
        for (const run of runs) yield* workflows.waitFor(run.runId, status("completed"));
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "onEnd runs once however the run ends, and a cancelled run's is tried until it works",
  () =>
    Effect.gen(function* () {
      const { boot, counts, failures, latch, clock } = yield* harness();
      const ended = (step: { readonly name: string }) => step.name === "onEnd";
      const heldId = yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const finished = yield* workflows.start(
            "owned",
            { mode: "finish" },
            { idempotencyKey: "f" },
          );
          const stopped = yield* workflows.start(
            "owned",
            { mode: "stop" },
            { idempotencyKey: "s" },
          );
          yield* workflows.waitFor(finished.runId, status("completed"));
          yield* workflows.waitFor(stopped.runId, status("stopped"));

          const held = yield* workflows.start("owned", { mode: "hold" }, { idempotencyKey: "h" });
          yield* workflows.waitFor(held.runId, status("waiting"));
          yield* Ref.set(failures, 1);
          // Time stands still from here, so no sweep tries again before the first try is read.
          yield* clock.close;
          yield* workflows.cancel(held.runId, "not needed");
          // The first try failed, which is on the run for a person to see.
          const firstTry = (yield* workflows.get(held.runId)).steps.find(ended);
          assert.deepStrictEqual(
            [firstTry?.status, firstTry?.detail],
            ["failed", "the machine would not go"],
          );
          // The next try rests a while however often the sweep looks, and needs its version.
          yield* workflows.sweep;
          const rested = (yield* workflows.get(held.runId)).steps.find(ended);
          assert.deepStrictEqual([rested?.status, rested?.attempts], ["failed", 1]);
          assert.deepInclude(yield* workflows.unfinished, { workflow: "owned", version: 1 });
          yield* clock.open;
          return held.runId;
        }),
      );
      // Days with the server down do not end the tries.
      yield* TestClock.adjust("2 days");
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          // The server's own sweep makes the next try.
          const { steps } = Option.getOrThrow(
            yield* workflows.watch.pipe(
              Stream.mapEffect(() => workflows.get(heldId)),
              Stream.filter((run) =>
                run.steps.some((step) => ended(step) && step.status === "completed"),
              ),
              Stream.runHead,
            ),
          );
          assert.deepStrictEqual(
            steps.map((step) => [step.name, step.status, step.attempts]),
            [
              ["take", "completed", 1],
              ["go", "failed", 1],
              ["onEnd", "completed", 2],
            ],
          );
          assert.notDeepInclude(yield* workflows.unfinished, { workflow: "owned", version: 1 });
          // Nothing is left to do, so another look changes nothing.
          yield* workflows.sweep;
          // A cleanup that works the first time is told why the run was cancelled, too.
          const second = yield* workflows.start(
            "owned",
            { mode: "hold" },
            { idempotencyKey: "h2" },
          );
          yield* workflows.waitFor(second.runId, status("waiting"));
          yield* workflows.cancel(second.runId, "changed my mind");
          const all = yield* Ref.get(counts);
          assert.deepStrictEqual(
            Object.entries(all).filter(([name]) => name.startsWith("end:")),
            [
              ["end:finish:completed:", 1],
              ["end:stop:stopped:no need", 1],
              ["end:hold:cancelled:not needed", 1],
              ["end:hold:cancelled:changed my mind", 1],
            ],
          );

          // Cancelled with a step still going: the cleanup waits for that step to finish.
          const busy = yield* workflows.start("owned", { mode: "busy" }, { idempotencyKey: "b" });
          yield* Deferred.await(latch.entered);
          // The cancel itself comes back after a while, the step still going.
          yield* workflows.cancel(busy.runId, "not needed");
          yield* Deferred.succeed(latch.release, undefined);
          yield* Deferred.await(latch.cleaned);
          assert.equal((yield* Ref.get(counts))["end:busy:after work"], 1);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "the store is shared by runs, survives a restart, and a failed transaction writes nothing",
  () =>
    Effect.gen(function* () {
      const { boot } = yield* harness();
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const runs = yield* Effect.forEach(["a", "b", "c"], (key) =>
            workflows.start("tally", {}, { idempotencyKey: key }),
          );
          const counted = yield* Effect.forEach(runs, (run) =>
            workflows.waitFor(run.runId, status("completed")),
          );
          assert.sameMembers(
            counted.map((run) => run.result),
            [1, 2, 3],
          );
        }),
      );
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          const next = yield* workflows.start("tally", {}, { idempotencyKey: "d" });
          assert.equal((yield* workflows.waitFor(next.runId, status("completed"))).result, 4);
          // A key read with another schema is the step's failure, with the key in the reason.
          const wrong = yield* workflows.start("tally", { wrong: true }, { idempotencyKey: "w" });
          const paused = yield* workflows.waitFor(wrong.runId, status("paused"));
          assert.include(paused.detail ?? "", "The stored value at tally does not fit its schema");

          // The first try fails inside the transaction, so the door it opened is not there, and
          // the try count it raised is 1 again on the second try, which is the one that signals.
          const waiting = yield* workflows.start("door", { door: "east" }, { idempotencyKey: "e" });
          yield* workflows.waitFor(waiting.runId, status("waiting"));
          const opener = yield* workflows.start(
            "opener",
            { door: "east", fail: true },
            { idempotencyKey: "o" },
          );
          yield* workflows.waitFor(opener.runId, status("paused"));
          assert.equal((yield* workflows.get(waiting.runId)).run.status, "waiting");
          const clean = yield* workflows.start(
            "opener",
            { door: "east", fail: false },
            { idempotencyKey: "o2" },
          );
          yield* workflows.waitFor(clean.runId, status("completed"));
          assert.equal(
            (yield* workflows.waitFor(waiting.runId, status("completed"))).result,
            "came in",
          );

          // A retry sends again what the first try sent, and what it sends anew is new.
          const doors = ["ra", "rb", "rc"];
          const held = yield* Effect.forEach(doors, (door) =>
            workflows.start("door", { door }, { idempotencyKey: door }),
          );
          yield* Effect.forEach(held, (run) => workflows.waitFor(run.runId, status("waiting")));
          const relay = yield* workflows.start("relay", { doors }, { idempotencyKey: "relay" });
          yield* workflows.waitFor(relay.runId, status("completed"));
          assert.equal(
            yield* workflows.signal({ workflow: "door", channel: "rc" }, "late", { id: "rc-late" }),
            "buffered",
          );
          const opened = yield* Effect.forEach(held, (run) =>
            workflows.waitFor(run.runId, status("completed")),
          );
          assert.deepStrictEqual(
            opened.map((run) => run.result),
            ["came in", "came in", "came in"],
          );
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("an invoked run reports how it ended, and cancelling the parent cancels it", () =>
  Effect.gen(function* () {
    const { boot } = yield* harness();
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        // The kid of a parent that waits on it, once the kid itself waits.
        const heldKid = Effect.gen(function* () {
          const kid = (yield* workflows.list({})).find(
            (run) =>
              run.workflow === "kid" && (run.status === "running" || run.status === "waiting"),
          );
          return yield* workflows.waitFor(kid!.runId, status("waiting"));
        });
        const finished = yield* workflows.start(
          "parent",
          { mode: "finish" },
          { idempotencyKey: "f" },
        );
        const stopped = yield* workflows.start("parent", { mode: "stop" }, { idempotencyKey: "s" });
        assert.equal(
          (yield* workflows.waitFor(finished.runId, status("completed"))).result,
          "grown",
        );
        assert.equal(
          (yield* workflows.waitFor(stopped.runId, status("completed"))).result,
          "stopped: nothing to do",
        );

        const held = yield* workflows.start("parent", { mode: "hold" }, { idempotencyKey: "h" });
        yield* workflows.waitFor(held.runId, (run) => run.detail === "kid");
        const child = yield* heldKid;
        yield* workflows.cancel(held.runId, "not needed");
        assert.equal((yield* workflows.get(child.runId)).run.status, "cancelled");

        // A kid cancelled by itself is an outcome its parent hears, not a failure.
        const second = yield* workflows.start("parent", { mode: "hold" }, { idempotencyKey: "h2" });
        yield* workflows.waitFor(second.runId, (run) => run.detail === "kid");
        const lone = yield* heldKid;
        yield* workflows.cancel(lone.runId, "changed my mind");
        assert.equal(
          (yield* workflows.waitFor(second.runId, status("completed"))).result,
          "cancelled: changed my mind",
        );

        const spawner = yield* workflows.start("spawner", {}, { idempotencyKey: "sp" });
        const spawned = (yield* workflows.waitFor(spawner.runId, status("completed")))
          .result as ReadonlyArray<string>;
        assert.equal(spawned.length, 2);
        for (const runId of spawned) {
          assert.equal((yield* workflows.waitFor(runId, status("completed"))).result, "grown");
        }

        // A name taken twice pauses the run before the kid it names is started.
        const clash = yield* workflows.start("clash", {}, { idempotencyKey: "c" });
        assert.include(
          (yield* workflows.waitFor(clash.runId, status("paused"))).detail ?? "",
          'named "kid"',
        );
        assert.deepStrictEqual(
          (yield* workflows.list()).filter((run) => run.parentRunId === clash.runId),
          [],
        );
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a cancel cut off midway still tells the run that invoked it", () =>
  Effect.gen(function* () {
    // The cancel is cut off where it stops the run's steps, as a client that went away would.
    const reached = yield* Deferred.make<void>();
    let first = true;
    const store = Layer.effect(
      WorkflowStore.WorkflowStore,
      Effect.map(WorkflowStore.make, (real) =>
        WorkflowStore.WorkflowStore.of({
          ...real,
          stepsCancelled: (runId, except) => {
            if (!first) return real.stepsCancelled(runId, except);
            first = false;
            return Effect.andThen(Deferred.succeed(reached, undefined), Effect.never);
          },
        }),
      ),
    );
    const { boot } = yield* harness(store);
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const parent = yield* workflows.start("parent", { mode: "hold" }, { idempotencyKey: "h" });
        yield* workflows.waitFor(parent.runId, (run) => run.detail === "kid");
        const kid = (yield* workflows.list({})).find((run) => run.workflow === "kid");
        yield* workflows.waitFor(kid!.runId, status("waiting"));
        const cancelling = yield* Effect.forkChild(workflows.cancel(kid!.runId, "changed my mind"));
        yield* Deferred.await(reached);
        yield* Fiber.interrupt(cancelling);
        assert.equal(
          (yield* workflows.waitFor(parent.runId, status("completed"))).result,
          "cancelled: changed my mind",
        );
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("two agents run side by side, and one past its time limit is stopped", () =>
  Effect.gen(function* () {
    const { boot, agents } = yield* harness();
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const run = yield* workflows.start("pair", {}, { idempotencyKey: "p" });
        // Both have started before either has ended.
        yield* agents.started(run.runId, "left/0");
        yield* agents.started(run.runId, "right/0");
        yield* agents.end(run.runId, "left/0", { reply: "done" });
        // The right one never answers. Its minute passes, and a stop that cannot get through
        // pauses the run without giving the turn up, so the next try stops it.
        agents.refuseStops(3);
        const refused = yield* workflows.waitFor(run.runId, status("paused"));
        assert.include(refused.detail ?? "", "the link is down");
        assert.equal(agents.interrupted.length, 0);
        const paused = yield* workflows.waitFor(
          run.runId,
          (current) => current.status === "paused" && current.detail !== refused.detail,
        );
        assert.include(paused.detail ?? "", "it was not done after 1m");
        assert.equal(agents.interrupted.length, 1);
        const { steps } = yield* workflows.get(run.runId);
        assert.deepStrictEqual(steps.map((step) => [step.name, step.status]).toSorted(), [
          ["left", "completed"],
          ["right", "failed"],
        ]);
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a continued thread keeps how it started", () =>
  Effect.gen(function* () {
    const { boot, agents } = yield* harness();
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const run = yield* workflows.start(
          "fix",
          { project: "p1", reshape: true },
          { idempotencyKey: "r1" },
        );
        yield* agents.started(run.runId, "write/0");
        yield* agents.end(run.runId, "write/0", { output: { branch: "fix/1" } });
        yield* workflows.waitFor(run.runId, (current) => current.detail === "merge");
        yield* workflows.signal(
          { runId: run.runId, wait: "merge" },
          { choice: "Merge" },
          { id: "m" },
        );
        const paused = yield* workflows.waitFor(run.runId, status("paused"));
        assert.include(paused.detail ?? "", "Drop `model`");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("an agent step in a linked environment keeps its thread there", () =>
  Effect.gen(function* () {
    const { boot, agents } = yield* harness();
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const run = yield* workflows.start(
          "fix",
          { project: "/work/app", environment: "env-b" },
          { idempotencyKey: "e1" },
        );
        const write = yield* agents.started(run.runId, "write/0");
        assert.equal(write.environment, "env-b");
        yield* agents.end(run.runId, "write/0", { output: { branch: "fix/1" } });
        yield* workflows.waitFor(run.runId, status("waiting"));
        yield* workflows.signal(
          { runId: run.runId, wait: "merge" },
          { choice: "Merge" },
          { id: "m1" },
        );

        // The step that continues the thread names no environment: the thread carries it.
        const land = yield* agents.started(run.runId, "land/0");
        assert.equal(land.environment, "env-b");
        assert.equal(land.thread, "thread-1");
        yield* workflows.waitFor(run.runId, (current) => current.detail === "agent land");
        const { steps } = yield* workflows.get(run.runId);
        assert.deepStrictEqual(
          steps.filter((step) => step.kind === "agent").map((step) => step.environmentId),
          ["env-b", "env-b"],
        );
        yield* workflows.cancel(run.runId, "not needed");
        // Only the step's own turn: someone else's turn on that thread is left alone.
        assert.deepStrictEqual(agents.interrupted, [
          { threadId: "thread-1", environment: "env-b", turnId: `${run.runId}/land/0` },
        ]);
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("cancelling a run stops its agent, and a turn a person stopped is not tried again", () =>
  Effect.gen(function* () {
    const { boot, agents } = yield* harness();
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const cancelled = yield* workflows.start(
          "fix",
          { project: "p1" },
          { idempotencyKey: "x1" },
        );
        yield* agents.started(cancelled.runId, "write/0");
        yield* workflows.waitFor(cancelled.runId, (run) => run.detail === "agent write");
        const { steps } = yield* workflows.get(cancelled.runId);
        yield* workflows.cancel(cancelled.runId, "not needed");
        assert.deepStrictEqual(agents.interrupted, [
          { threadId: steps[0]?.threadId ?? "no thread", turnId: `${cancelled.runId}/write/0` },
        ]);

        const stopped = yield* workflows.start("fix", { project: "p1" }, { idempotencyKey: "x2" });
        yield* agents.started(stopped.runId, "write/0");
        yield* agents.end(stopped.runId, "write/0", { ending: "stopped", detail: "interrupted" });
        const paused = yield* workflows.waitFor(stopped.runId, status("paused"));
        assert.include(paused.detail ?? "", "stopped");
        // Resuming is the person saying go on: the next round starts.
        yield* workflows.resume(stopped.runId);
        yield* agents.started(stopped.runId, "write/1");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a watcher is sent the runs again when one changes", () =>
  Effect.gen(function* () {
    const { boot } = yield* harness();
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const first = Option.getOrThrow(yield* Stream.runHead(workflows.watch));
        assert.deepStrictEqual([first.runs, first.questions], [[], []]);
        // What exists is listed before anything has run, with what starts it.
        assert.deepInclude(first.workflows, {
          name: "inbound",
          version: 1,
          triggers: ["webhook push"],
        });
        const { runId } = yield* workflows.start(
          "review",
          { change: "c9", timeout: "1 hour" },
          { idempotencyKey: "c9" },
        );
        const seen = yield* workflows.watch.pipe(
          Stream.filter((snapshot) => snapshot.runs.some((run) => run.status === "waiting")),
          Stream.runHead,
        );
        assert.deepStrictEqual(
          Option.getOrThrow(seen).runs.map((run) => run.runId),
          [runId],
        );
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "a schedule starts one run when it is due, and one for all the times a restart missed",
  () =>
    Effect.gen(function* () {
      const { boot } = yield* harness();
      const nightly = (workflows: Workflows.Workflows["Service"]) =>
        Effect.map(workflows.list(), (runs) => runs.filter((run) => run.workflow === "nightly"));
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          // The first look only notes when it is next due.
          yield* workflows.sweep;
          assert.deepStrictEqual(yield* nightly(workflows), []);
          // A start that fails is tried again, not passed over for the next time it is due.
          ticks.refused = true;
          yield* TestClock.adjust("61 minutes");
          yield* workflows.sweep;
          assert.deepStrictEqual(yield* nightly(workflows), []);
          ticks.refused = false;
          yield* workflows.sweep;
          yield* workflows.sweep;
          const [run] = yield* nightly(workflows);
          assert.equal((yield* nightly(workflows)).length, 1);
          const done = yield* workflows.waitFor(run!.runId, status("completed"));
          assert.match(String(done.result), /^1970-01-01T01:/);
        }),
      );
      yield* TestClock.adjust("3 hours");
      yield* boot(
        Effect.gen(function* () {
          const workflows = yield* Workflows.Workflows;
          yield* workflows.sweep;
          yield* workflows.sweep;
          assert.equal((yield* nightly(workflows)).length, 2);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("an issue opened after the workflow loaded starts one run, which can comment on it", () =>
  Effect.gen(function* () {
    const starts: Array<string> = [];
    const store = Layer.effect(
      WorkflowStore.WorkflowStore,
      Effect.map(WorkflowStore.make, (real) =>
        WorkflowStore.WorkflowStore.of({
          ...real,
          runStarted: (run) =>
            Effect.andThen(
              Effect.sync(() => starts.push(run.idempotencyKey)),
              real.runStarted(run),
            ),
        }),
      ),
    );
    const { boot, forge } = yield* harness(store);
    const triaged = (workflows: Workflows.Workflows["Service"]) =>
      Effect.map(workflows.list(), (runs) => runs.filter((run) => run.workflow === "triage"));
    forge.open.push(issueAt("1", "1969-12-31T23:00:00.000Z"));
    // Before the mark too, written the way some hosts write a time.
    forge.open.push(issueAt("3", "1970-01-01T00:30:00+01:00"));
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        // The first look only notes the time: what was there already starts nothing.
        yield* workflows.sweep;
        yield* TestClock.adjust("2 minutes");
        // One the workflow turns down comes first, and does not hold back the one after it.
        forge.open.push({ ...issueAt("bad", "1970-01-01T00:00:30.000Z"), title: 5 } as never);
        forge.open.push(issueAt("2", "1970-01-01T00:01:00.000Z"));
        yield* workflows.sweep;
        yield* TestClock.adjust("2 minutes");
        yield* workflows.sweep;
        const [run, ...others] = yield* triaged(workflows);
        assert.deepStrictEqual(others, []);
        const done = yield* workflows.waitFor(run!.runId, status("completed"));
        assert.equal(done.result, "#2");
        assert.deepStrictEqual(forge.comments, ["2: Looking at Issue 2."]);
        // A later look still lists it, and leaves the run it has alone.
        const before = starts.length;
        yield* TestClock.adjust("2 minutes");
        yield* workflows.sweep;
        assert.deepStrictEqual(starts.slice(before), []);
        assert.deepStrictEqual(forge.asked.at(-1), {
          project: PROJECT,
          state: "all",
          sort: "created",
          limit: 100,
          labels: ["bug"],
          query: undefined,
        });
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a wait on a pull request ends when its checks have, and says how", () =>
  Effect.gen(function* () {
    const { boot, forge } = yield* harness();
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const { runId } = yield* workflows.start(
          "land",
          { url: forge.pullRequest.url },
          { idempotencyKey: "pr-7" },
        );
        yield* workflows.waitFor(runId, status("waiting"));
        yield* workflows.sweep;
        assert.equal((yield* workflows.waitFor(runId, () => true)).status, "waiting");
        // Not a question for anyone: nothing waits on a person.
        assert.deepStrictEqual(yield* workflows.questions, []);
        forge.pullRequest.checks[0]!.status = "success";
        yield* TestClock.adjust("2 minutes");
        yield* workflows.sweep;
        const done = yield* workflows.waitFor(runId, status("completed"));
        assert.equal(done.result, "passing");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a request to a hook starts a run, its retry is the same run, and a bad token none", () =>
  Effect.gen(function* () {
    const { boot } = yield* harness();
    const request = (body: string, delivery: string) => ({
      method: "POST",
      headers: { "x-delivery": delivery },
      query: "",
      body,
    });
    const token = yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const [hook] = yield* workflows.hooks;
        assert.equal(hook?.workflow, "inbound");
        const [hookId, token] = hook!.path.split("/").slice(-2).map(decodeURIComponent);
        const deliver = (body: string, delivery: string, withToken = token!) =>
          workflows.deliver({
            hookId: hookId!,
            token: withToken,
            request: request(body, delivery),
          });

        assert.isTrue(Option.isNone(yield* deliver("hello", "d1", "not the token")));
        const first = Option.getOrThrow(yield* deliver("hello", "d1"));
        assert.deepStrictEqual(Option.getOrThrow(yield* deliver("hello", "d1")), first);
        const done = yield* workflows.waitFor(first.runId, status("completed"));
        assert.equal(done.result, "hello");

        const ping = Option.getOrThrow(yield* deliver("ping", "d2"));
        const skipped = yield* workflows.waitFor(ping.runId, status("skipped"));
        assert.equal(skipped.detail, "only a ping");

        const send = (headers: Record<string, string>, body: string) =>
          workflows.deliver({
            hookId: hookId!,
            token: token!,
            request: { method: "POST", headers, query: "", body },
          });
        // With no key from the workflow, the id the sender keeps on its retry makes it one run.
        const github = { "x-github-delivery": "g1" };
        const sent = Option.getOrThrow(yield* send(github, "{}"));
        assert.deepStrictEqual(Option.getOrThrow(yield* send(github, "{}")), sent);
        // A key the workflow cannot read off the request turns the request down.
        const unreadable = yield* send({}, "not json").pipe(Effect.flip);
        assert.equal(unreadable._tag, "WorkflowInputError");
        return token;
      }),
    );
    // The URL a sender was given still works after a restart.
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        assert.isTrue((yield* workflows.hooks)[0]?.path.endsWith(`/${token}`));
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a step finds runs by their key, wakes everyone at a key, and cancels another run", () =>
  Effect.gen(function* () {
    const { boot } = yield* harness();
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const visit = (key: string, at: string) =>
          workflows.start("gate", { gate: at }, { idempotencyKey: key });
        const keeper = Effect.fn(function* (act: "look" | "open" | "dismiss" | "leave") {
          const run = yield* workflows.start("keeper", { act }, { idempotencyKey: act });
          return yield* workflows.waitFor(run.runId, status("completed", "paused"));
        });
        const [one, two, three] = yield* Effect.all([
          visit("visit/1", "north"),
          visit("visit/2", "north"),
          visit("visit/3", "south"),
        ]);
        // Not at a gate, and not started as a visit: none of the keeper's business.
        yield* workflows.start("review", { change: "north" }, { idempotencyKey: "other" });
        for (const run of [one, two, three]) yield* workflows.waitFor(run.runId, status("waiting"));

        assert.deepStrictEqual((yield* keeper("look")).result, [
          "visit/1 waiting",
          "visit/2 waiting",
          "visit/3 waiting",
        ]);
        // Both at the north gate go through on one signal; the one at the south gate stays.
        assert.equal((yield* keeper("open")).result, 2);
        for (const run of [one, two]) {
          assert.equal((yield* workflows.waitFor(run.runId, status("completed"))).result, "go on");
        }
        assert.equal((yield* workflows.get(three.runId)).run.status, "waiting");

        yield* keeper("dismiss");
        const dismissed = (yield* workflows.get(three.runId)).run;
        assert.deepStrictEqual(
          [dismissed.status, dismissed.detail],
          ["cancelled", "the gate is closed"],
        );
        // A run ends itself with `stop`; cancelling itself would cut the cancel short.
        const left = yield* keeper("leave");
        assert.equal(left.status, "paused");
        assert.include(left.detail ?? "", "cannot cancel itself");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a workflow can take an agent's failure as an answer and go on", () =>
  Effect.gen(function* () {
    const { boot, agents } = yield* harness();
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        // The first agent's turn dies, and so does the one more try it gets.
        const died = yield* workflows.start("fallback", { project: "p1" }, { idempotencyKey: "d" });
        yield* agents.started(died.runId, "first/0");
        yield* agents.end(died.runId, "first/0", { ending: "failed", detail: "failed" });
        yield* agents.started(died.runId, "first/1");
        yield* agents.end(died.runId, "first/1", { ending: "failed", detail: "failed" });
        yield* agents.started(died.runId, "second/0");
        yield* agents.end(died.runId, "second/0", { output: { head: "abc" } });
        const done = yield* workflows.waitFor(died.runId, status("completed", "paused"));
        assert.deepStrictEqual(
          [done.status, done.pauses, done.result],
          ["completed", 0, "abc after: the agent's turn was cut short: failed"],
        );
        const { steps } = yield* workflows.get(died.runId);
        assert.deepStrictEqual(
          steps.map((step) => [step.name, step.status]),
          [
            ["first", "failed"],
            ["second", "completed"],
          ],
        );

        // An agent that cannot be started at all is an answer too.
        const lost = yield* workflows.start(
          "fallback",
          { project: "nowhere" },
          { idempotencyKey: "n" },
        );
        yield* agents.started(lost.runId, "second/0");
        yield* agents.end(lost.runId, "second/0", { output: { head: "def" } });
        const found = yield* workflows.waitFor(lost.runId, status("completed", "paused"));
        assert.equal(
          found.result,
          "def after: the agent could not be started: No project is registered there.",
        );

        // A result that cannot be read leaves the turn maybe running: a stop that fails gives up
        // the step, and no second turn starts beside it.
        const stopsBefore = agents.interrupted.length;
        agents.refuseStops(3);
        agents.unreadableResult("first/0");
        const unread = yield* workflows.start(
          "fallback",
          { project: "p1" },
          { idempotencyKey: "u" },
        );
        yield* agents.started(unread.runId, "second/0");
        assert.equal(agents.interrupted.length, stopsBefore);
        yield* agents.end(unread.runId, "second/0", { output: { head: "jkl" } });
        const gaveUp = yield* workflows.waitFor(unread.runId, status("completed", "paused"));
        assert.include(gaveUp.result as string, "its turn could not be stopped");

        // One past its time whose turn cannot be stopped says so, for the workflow to weigh.
        agents.refuseStops(3);
        const stuck = yield* workflows.start(
          "fallback",
          { project: "p1", timeout: "1 minute" },
          { idempotencyKey: "s" },
        );
        yield* agents.started(stuck.runId, "second/0");
        yield* agents.end(stuck.runId, "second/0", { output: { head: "ghi" } });
        const weighed = yield* workflows.waitFor(stuck.runId, status("completed", "paused"));
        assert.include(weighed.result as string, "its turn could not be stopped");

        // A stop turned down once gets through on its retry, and the step says it was stopped.
        const before = agents.interrupted.length;
        agents.refuseStops(1);
        const late = yield* workflows.start(
          "fallback",
          { project: "p1", timeout: "1 minute" },
          { idempotencyKey: "l" },
        );
        yield* agents.started(late.runId, "second/0");
        assert.equal(agents.interrupted.length, before + 1);
        yield* agents.end(late.runId, "second/0", { output: { head: "mno" } });
        const retried = yield* workflows.waitFor(late.runId, status("completed", "paused"));
        assert.equal(retried.status, "completed");
        assert.notInclude(retried.result as string, "could not be stopped");

        // A result that arrived as its time ran out, before it was read, is still the answer.
        agents.unansweredResult("first/0");
        const lastMinute = yield* workflows.start(
          "fallback",
          { project: "p1", timeout: "1 minute" },
          { idempotencyKey: "m" },
        );
        yield* agents.started(lastMinute.runId, "first/0");
        yield* agents.end(lastMinute.runId, "first/0", { output: { head: "pqr" } });
        yield* agents.end(lastMinute.runId, "second/0", { output: { head: "not needed" } });
        const answered = yield* workflows.waitFor(lastMinute.runId, status("completed", "paused"));
        assert.equal(answered.result, "pqr");

        // One whose turn had ended without its result is not said to be stopped: the agent may
        // answer from a later turn nobody stopped.
        agents.unansweredResult("first/0");
        const owing = yield* workflows.start(
          "fallback",
          { project: "p1", timeout: "1 minute" },
          { idempotencyKey: "o" },
        );
        yield* agents.started(owing.runId, "first/0");
        yield* agents.end(owing.runId, "first/0", {});
        yield* agents.started(owing.runId, "second/0");
        yield* agents.end(owing.runId, "second/0", { output: { head: "stu" } });
        const owed = yield* workflows.waitFor(owing.runId, status("completed", "paused"));
        assert.include(owed.result as string, "may still be at work");

        // One that did the work and never gave its result is not given the job again: it may
        // have acted on it already.
        const silent = yield* workflows.start(
          "fallback",
          { project: "p1", thread: true },
          { idempotencyKey: "q" },
        );
        for (const key of ["first/0", "first/0/correct/0", "first/0/correct/1"]) {
          yield* agents.started(silent.runId, key);
          yield* agents.end(silent.runId, key, {});
        }
        yield* agents.end(silent.runId, "first/1", { output: { head: "twice" } });
        yield* agents.end(silent.runId, "second/0", { output: { head: "vwx" } });
        const once = yield* workflows.waitFor(silent.runId, status("completed", "paused"));
        assert.match(
          once.result as string,
          /^vwx after: the agent did not return a result: .* in thread-\d+$/,
        );

        // A correction that cannot be sent leaves the failure with the thread the work is in.
        const unasked = yield* workflows.start(
          "fallback",
          { project: "p1", thread: true },
          { idempotencyKey: "c" },
        );
        agents.unstartable(unasked.runId, "first/0/correct/0");
        yield* agents.started(unasked.runId, "first/0");
        yield* agents.end(unasked.runId, "first/0", {});
        yield* agents.end(unasked.runId, "second/0", { output: { head: "yz" } });
        const kept = yield* workflows.waitFor(unasked.runId, status("completed", "paused"));
        assert.match(kept.result as string, /could not be asked again: .* in thread-\d+$/);
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
