import * as Workflows from "alchemy/Workflows";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Activity, DurableClock, DurableDeferred, Workflow } from "effect/workflow";
import { Journal } from "./journal.ts";

export class Declined extends Schema.TaggedError<Declined>()("Declined", {
  reason: Schema.String,
}) {}

/** Two activities and a result. */
export const Greet = Workflow.make("Greet", {
  payload: { id: Schema.String, name: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/** Sleeps durably between two activities. */
export const Nap = Workflow.make("Nap", {
  payload: { id: Schema.String, seconds: Schema.Number },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/** Sleeps several times in a row, so each wake-up is scheduled from the one before. */
export const Naps = Workflow.make("Naps", {
  payload: { id: Schema.String, seconds: Schema.Number, count: Schema.Number },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/** Waits for someone outside to approve it. */
export const Approval = DurableDeferred.make("approval", { success: Schema.String });

export const Approve = Workflow.make("Approve", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/** Reserves, then waits for approval; interrupted while it waits, it releases the reservation. */
export const Hold = Workflow.make("Hold", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/**
 * Reserves, then charges; a declined charge releases the reservation. An
 * abandoned checkout fails after reserving, without charging, and releases it
 * too.
 */
export const Checkout = Workflow.make("Checkout", {
  payload: { id: Schema.String, decline: Schema.Boolean, abandon: Schema.Boolean },
  success: Schema.String,
  error: Declined,
  idempotencyKey: ({ id }) => id,
});

/** Runs Greet as a child workflow. */
export const Parent = Workflow.make("Parent", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/**
 * Its first activity dies twice before it succeeds, then it sleeps. A defect
 * fails the run instead of the workflow, so the engine retries the run.
 */
export const Flaky = Workflow.make("Flaky", {
  payload: { id: Schema.String, seconds: Schema.Number },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
}).annotate(Workflow.CaptureDefects, false);

/** An activity that dies. By default a defect is the workflow's result, not retried. */
export const Crash = Workflow.make("Crash", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

export class Flake extends Schema.TaggedError<Flake>()("Flake", { attempt: Schema.Number }) {}

/** Its activity fails with a typed error twice, and `Activity.retry` runs it again. */
export const Retry = Workflow.make("Retry", {
  payload: { id: Schema.String },
  success: Schema.String,
  error: Flake,
  idempotencyKey: ({ id }) => id,
});

/** Sleeps durably inside an activity, which returns a `DateTime` the workflow decodes. */
export const WakeInStep = Workflow.make("WakeInStep", {
  payload: { id: Schema.String, seconds: Schema.Number },
  success: Schema.DateTimeUtc,
  idempotencyKey: ({ id }) => id,
});

/**
 * Reserves, then waits for approval inside `catchCause` and `ensuring`, with a
 * finalizer. Suspending runs the finalizer and `ensuring`, never the
 * compensation or `catchCause`.
 */
export const Guarded = Workflow.make("Guarded", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/** Races three activities, then waits for approval: a replay returns the same winner. */
export const Race = Workflow.make("Race", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/** Runs Approve as a child, so the parent waits while the child waits for its signal. */
export const ParentOfWaiting = Workflow.make("ParentOfWaiting", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/**
 * Reserves, then its activity dies once, and the workflow suspends instead of
 * failing. Resumed, the activity runs again and succeeds; interrupted, the
 * reservation is released.
 */
export const Suspends = Workflow.make("Suspends", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
}).annotate(Workflow.SuspendOnFailure, true);

/** Catches its dying activity's defect and carries on with another activity. */
export const Recover = Workflow.make("Recover", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/** Runs three activities at once. */
export const Fanout = Workflow.make("Fanout", {
  payload: { id: Schema.String },
  success: Schema.Number,
  idempotencyKey: ({ id }) => id,
});

/** Runs a declined Checkout as a child, and handles the child's typed failure. */
export const ParentOfFailing = Workflow.make("ParentOfFailing", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
});

/** Every conformance workflow, for the engine that hosts them. */
export const workflows = [
  Greet,
  Nap,
  Naps,
  Approve,
  Hold,
  Checkout,
  Parent,
  Flaky,
  Crash,
  Retry,
  WakeInStep,
  Guarded,
  Race,
  ParentOfWaiting,
  Suspends,
  Recover,
  Fanout,
  ParentOfFailing,
] as const;

export const GreetLive = Workflows.layer(
  Greet,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id, name }) {
      const greeting = yield* Activity.make({
        name: "greet",
        success: Schema.String,
        execute: journal.append(id, "greet").pipe(Effect.as(`hello ${name}`)),
      });
      yield* Activity.make({ name: "log", execute: journal.append(id, "log") });
      return greeting;
    });
  }),
);

export const NapLive = Workflows.layer(
  Nap,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id, seconds }) {
      yield* Activity.make({ name: "before", execute: journal.append(id, "before") });
      yield* DurableClock.sleep({
        name: "nap",
        duration: `${seconds} seconds`,
        inMemoryThreshold: 0,
      });
      yield* Activity.make({ name: "after", execute: journal.append(id, "after") });
      return "rested";
    });
  }),
);

export const NapsLive = Workflows.layer(
  Naps,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id, seconds, count }) {
      for (let nap = 0; nap < count; nap++) {
        yield* DurableClock.sleep({
          name: `nap-${nap}`,
          duration: `${seconds} seconds`,
          inMemoryThreshold: 0,
        });
      }
      yield* Activity.make({ name: "after", execute: journal.append(id, "after") });
      return "rested";
    });
  }),
);

export const ApproveLive = Workflows.layer(
  Approve,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      yield* Activity.make({ name: "requested", execute: journal.append(id, "requested") });
      const by = yield* DurableDeferred.await(Approval);
      yield* Activity.make({ name: "approved", execute: journal.append(id, `approved:${by}`) });
      return `approved by ${by}`;
    });
  }),
);

export const HoldLive = Workflows.layer(
  Hold,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      yield* Activity.make({ name: "reserve", execute: journal.append(id, "reserve") }).pipe(
        Hold.withCompensation(() =>
          Activity.make({ name: "release", execute: journal.append(id, "release") }),
        ),
      );
      const by = yield* DurableDeferred.await(Approval);
      return `held for ${by}`;
    });
  }),
);

export const CheckoutLive = Workflows.layer(
  Checkout,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id, decline, abandon }) {
      yield* Activity.make({ name: "reserve", execute: journal.append(id, "reserve") }).pipe(
        Checkout.withCompensation(() =>
          Activity.make({ name: "release", execute: journal.append(id, "release") }),
        ),
      );
      if (abandon) return yield* new Declined({ reason: "abandoned" });
      return yield* Activity.make({
        name: "charge",
        success: Schema.String,
        error: Declined,
        execute: decline
          ? journal
              .append(id, "declined")
              .pipe(Effect.andThen(new Declined({ reason: "card declined" })))
          : journal.append(id, "charged").pipe(Effect.as("charged")),
      });
    });
  }),
);

export const ParentLive = Workflows.layer(
  Parent,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      const greeting = yield* Greet.execute({ id: `${id}-child`, name: "child" });
      yield* Activity.make({ name: "parent", execute: journal.append(id, `parent:${greeting}`) });
      return `parent got ${greeting}`;
    });
  }),
);

export const FlakyLive = Workflows.layer(
  Flaky,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id, seconds }) {
      yield* Activity.make({
        name: "flaky",
        execute: Effect.gen(function* () {
          yield* journal.append(id, "attempt");
          const attempts = (yield* journal.list(id)).filter((entry) => entry === "attempt").length;
          if (attempts < 3) return yield* Effect.die(`attempt ${attempts} died`);
        }),
      });
      yield* DurableClock.sleep({
        name: "after-flaky",
        duration: `${seconds} seconds`,
        inMemoryThreshold: 0,
      });
      yield* Activity.make({ name: "after", execute: journal.append(id, "after") });
      return "recovered";
    });
  }),
);

export const CrashLive = Workflows.layer(
  Crash,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      yield* Activity.make({
        name: "crash",
        // An Error carrying a field JSON can't encode: the engine still reports it.
        execute: journal
          .append(id, "crash")
          .pipe(
            Effect.andThen(
              Effect.die(Object.assign(new Error("boom: request timed out"), { code: 1n })),
            ),
          ),
      });
      return "unreachable";
    });
  }),
);

export const RetryLive = Workflows.layer(
  Retry,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      const attempt = yield* Activity.make({
        name: "flaky",
        success: Schema.Number,
        error: Flake,
        execute: Effect.gen(function* () {
          const attempt = yield* Activity.CurrentAttempt;
          yield* journal.append(id, `attempt:${attempt}`);
          if (attempt < 3) return yield* new Flake({ attempt });
          return attempt;
        }),
      }).pipe(Activity.retry({ times: 5 }));
      return `succeeded on attempt ${attempt}`;
    });
  }),
);

export const WakeInStepLive = Workflows.layer(
  WakeInStep,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id, seconds }) {
      const at = yield* Activity.make({
        name: "nap-in-step",
        success: Schema.DateTimeUtc,
        execute: Effect.gen(function* () {
          yield* DurableClock.sleep({
            name: "inside",
            duration: `${seconds} seconds`,
            inMemoryThreshold: 0,
          });
          yield* journal.append(id, "woke");
          return yield* DateTime.now;
        }),
      });
      yield* Activity.make({
        name: "decoded",
        execute: journal.append(id, DateTime.isDateTime(at) ? "decoded" : "not decoded"),
      });
      return at;
    });
  }),
);

export const GuardedLive = Workflows.layer(
  Guarded,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      yield* Effect.addFinalizer(() => journal.append(id, "finalized"));
      yield* Activity.make({ name: "reserve", execute: journal.append(id, "reserve") }).pipe(
        Guarded.withCompensation(() =>
          Activity.make({ name: "release", execute: journal.append(id, "release") }),
        ),
      );
      const by = yield* DurableDeferred.await(Approval).pipe(
        Effect.catchCause(() => journal.append(id, "caught").pipe(Effect.as("nobody"))),
        Effect.ensuring(journal.append(id, "ensured")),
      );
      yield* Activity.make({ name: "done", execute: journal.append(id, `done:${by}`) });
      return `guarded for ${by}`;
    });
  }),
);

export const RaceLive = Workflows.layer(
  Race,
  Effect.gen(function* () {
    const journal = yield* Journal;
    const runner = (name: string, millis: number) =>
      Activity.make({
        name,
        success: Schema.String,
        execute: Effect.sleep(`${millis} millis`).pipe(Effect.as(name)),
      });
    return Effect.fn(function* ({ id }) {
      const winner = yield* Activity.raceAll("race", [
        runner("slow", 3_000),
        runner("medium", 1_500),
        runner("fast", 100),
      ]);
      yield* Activity.make({ name: "raced", execute: journal.append(id, `raced:${winner}`) });
      // Replayed after the signal: the race returns its recorded winner.
      yield* DurableDeferred.await(Approval);
      return winner;
    });
  }),
);

export const ParentOfWaitingLive = Workflows.layer(
  ParentOfWaiting,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      const approved = yield* Approve.execute({ id: `${id}-child` });
      yield* Activity.make({ name: "parent", execute: journal.append(id, `parent:${approved}`) });
      return `parent got ${approved}`;
    });
  }),
);

export const SuspendsLive = Workflows.layer(
  Suspends,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      yield* Activity.make({ name: "reserve", execute: journal.append(id, "reserve") }).pipe(
        Suspends.withCompensation(() =>
          Activity.make({ name: "release", execute: journal.append(id, "release") }),
        ),
      );
      yield* Activity.make({
        name: "flaky",
        execute: Effect.gen(function* () {
          yield* journal.append(id, "attempt");
          const attempts = (yield* journal.list(id)).filter((entry) => entry === "attempt").length;
          if (attempts < 2) return yield* Effect.die("boom");
        }),
      });
      return "resumed";
    });
  }),
);

export const RecoverLive = Workflows.layer(
  Recover,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      return yield* Activity.make({
        name: "fail",
        success: Schema.String,
        execute: journal.append(id, "fail").pipe(Effect.andThen(Effect.die("boom"))),
      }).pipe(
        Effect.catchCause(() =>
          Activity.make({
            name: "recovered",
            success: Schema.String,
            execute: journal.append(id, "recovered").pipe(Effect.as("recovered")),
          }),
        ),
      );
    });
  }),
);

export const FanoutLive = Workflows.layer(
  Fanout,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      const parts = yield* Effect.all(
        [1, 2, 3].map((part) =>
          Activity.make({
            name: `part-${part}`,
            success: Schema.Number,
            execute: journal.append(id, `part:${part}`).pipe(Effect.as(part)),
          }),
        ),
        { concurrency: "unbounded" },
      );
      return parts.reduce((sum, part) => sum + part, 0);
    });
  }),
);

export const ParentOfFailingLive = Workflows.layer(
  ParentOfFailing,
  Effect.gen(function* () {
    const journal = yield* Journal;
    return Effect.fn(function* ({ id }) {
      const outcome = yield* Checkout.execute({
        id: `${id}-child`,
        decline: true,
        abandon: false,
      }).pipe(Effect.catchTag("Declined", ({ reason }) => Effect.succeed(`child ${reason}`)));
      yield* Activity.make({ name: "parent", execute: journal.append(id, `parent:${outcome}`) });
      return outcome;
    });
  }),
);

/** Every conformance workflow's implementation. Provide the cloud's `Journal` and engine. */
export const WorkflowsLive = Layer.mergeAll(
  GreetLive,
  NapLive,
  NapsLive,
  ApproveLive,
  HoldLive,
  CheckoutLive,
  ParentLive,
  FlakyLive,
  CrashLive,
  RetryLive,
  WakeInStepLive,
  GuardedLive,
  RaceLive,
  ParentOfWaitingLive,
  SuspendsLive,
  RecoverLive,
  FanoutLive,
  ParentOfFailingLive,
);
