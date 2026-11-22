import * as Domain from "@alchemy.run/domain";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------- two aggregates

class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
}) {}
class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit],
  decide: { Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })] },
  evolve: { Deposited: (s, e) => ({ balance: s.balance + e.amount }) },
}) {}

class Logged extends Domain.Event("Logged", { note: Schema.String }) {}
class Log extends Domain.Command("Log", {
  target: Schema.String,
  input: { note: Schema.String },
  events: [Logged],
}) {}
class Journal extends Domain.Aggregate("Journal", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Log],
  decide: { Log: (_, cmd) => [new Logged({ note: cmd.note })] },
  evolve: { Logged: (s) => s },
}) {}

// ---------------------------------------------------------------- consumers added later

/** Every deposit to an account, in the order the view applied them. */
class Deposits extends Domain.View("Deposits", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ amounts: Schema.Array(Schema.Number) }),
  initial: { amounts: [] },
  evolve: { Deposited: (s, e) => ({ amounts: [...s.amounts, e.amount] }) },
}) {}

/** Counts what reaches it: a policy must never act on replayed history. */
class Reactions extends Context.Service<Reactions, Ref.Ref<number>>()("Test/Reactions") {}
class OnDeposit extends Domain.Policy("OnDeposit", { from: [Deposits], on: [Deposited] }) {}
const OnDepositLive = OnDeposit.toLayer(
  Effect.gen(function* () {
    const reactions = yield* Reactions;
    return Effect.fn(function* () {
      yield* Ref.update(reactions, (n) => n + 1);
    });
  }),
);

/** A store outside the model: what one projection key received, in order. */
class Feed extends Context.Service<Feed, Ref.Ref<ReadonlyArray<string>>>()("Test/Feed") {}
class Timeline extends Domain.Projection("Timeline", {
  from: [Account, Journal],
  key: Schema.String,
  keyOf: { Deposited: () => "all", Logged: () => "all" },
  on: [Deposited, Logged],
}) {}
const timelineLayer = (options?: Domain.Projection.Options) =>
  Timeline.toLayer(
    Effect.gen(function* () {
      const feed = yield* Feed;
      return Effect.fn(function* (batch) {
        yield* Ref.update(feed, (all) => [
          ...all,
          ...batch.map(({ event }) =>
            event._tag === "Deposited" ? `deposit ${event.amount}` : `log ${event.note}`,
          ),
        ]);
      });
    }),
    options,
  );
const TimelineLive = timelineLayer();

/** The same view, redefined: it now records each deposit doubled. */
class DoubledDeposits extends Domain.View("Deposits", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ amounts: Schema.Array(Schema.Number) }),
  initial: { amounts: [] },
  evolve: { Deposited: (s, e) => ({ amounts: [...s.amounts, e.amount * 2] }) },
}) {}

/** Every deposit, in the order the view applied them: one key. */
class Activity extends Domain.View("Activity", {
  from: [Account],
  key: Schema.String,
  keyOf: { Deposited: () => "all" },
  state: Schema.Struct({ entries: Schema.Array(Schema.String) }),
  initial: { entries: [] },
  evolve: { Deposited: (s, e) => ({ entries: [...s.entries, `deposit ${e.amount}`] }) },
}) {}

/** The same view, now reading the journal too. */
class WideActivity extends Domain.View("Activity", {
  from: [Account, Journal],
  key: Schema.String,
  keyOf: { Deposited: () => "all", Logged: () => "all" },
  state: Schema.Struct({ entries: Schema.Array(Schema.String) }),
  initial: { entries: [] },
  evolve: {
    Deposited: (s, e) => ({ entries: [...s.entries, `deposit ${e.amount}`] }),
    Logged: (s, e) => ({ entries: [...s.entries, `log ${e.note}`] }),
  },
}) {}

/** The views again, each at version 1: what bumping a version deploys. */
class DepositsV1 extends Domain.View("Deposits", { ...Deposits.definition, version: 1 }) {}
class DoubledDepositsV1 extends Domain.View("Deposits", {
  ...DoubledDeposits.definition,
  version: 1,
}) {}
class WideActivityV1 extends Domain.View("Activity", { ...WideActivity.definition, version: 1 }) {}

// ---------------------------------------------------------------- one model, three deploys

class Before extends Domain.Model("Bank", { aggregates: [Account, Journal] }) {}
class WithView extends Domain.Model("Bank", {
  aggregates: [Account, Journal],
  views: [Deposits],
  policies: [OnDeposit],
}) {}
class Redefined extends Domain.Model("Bank", {
  aggregates: [Account, Journal],
  views: [DoubledDeposits],
}) {}
class WithTimeline extends Domain.Model("Bank", {
  aggregates: [Account, Journal],
  projections: [Timeline],
}) {}

class WithActivity extends Domain.Model("Bank", {
  aggregates: [Account, Journal],
  views: [Activity],
}) {}
class WithWideActivity extends Domain.Model("Bank", {
  aggregates: [Account, Journal],
  views: [WideActivity],
}) {}
class WithWideActivityV1 extends Domain.Model("Bank", {
  aggregates: [Account, Journal],
  views: [WideActivityV1],
}) {}
class WithViewV1 extends Domain.Model("Bank", {
  aggregates: [Account, Journal],
  views: [DepositsV1],
}) {}
class RedefinedV1 extends Domain.Model("Bank", {
  aggregates: [Account, Journal],
  views: [DoubledDepositsV1],
}) {}

const HOUR = 60 * 60 * 1000;

/**
 * An in-memory platform that outlives the models built on it, as storage
 * outlives a deploy. `deploy` builds a model on it and runs `effect` against
 * that build; the platform delivers only when drained.
 */
const platform = () => {
  const clock = { now: 0 };
  const hosted = InMemory.make({ manual: true, now: () => clock.now });
  const services = Layer.mergeAll(
    Layer.effect(Reactions, Ref.make(0)),
    Layer.effect(Feed, Ref.make<ReadonlyArray<string>>([])),
  );
  // Deliver everything queued, and wait for the projection runs it forks.
  const settle: Effect.Effect<void> = Effect.gen(function* () {
    while (true) {
      yield* hosted.control.drain;
      if (yield* hosted.control.idle) return;
      yield* Effect.sleep("1 millis");
    }
  });
  return {
    clock,
    hosted,
    settle,
    services,
    deploy: <A, E, R, P, PE, PR>(
      model: { readonly layer: (policies: any, options?: any) => Layer.Layer<any, any, any> },
      policies: Layer.Layer<P, PE, PR>,
      effect: Effect.Effect<A, E, R>,
      options?: Domain.Model.LayerOptions,
    ) =>
      effect.pipe(
        Effect.tap(() => settle),
        Effect.provide(model.layer(policies, options).pipe(Layer.provide(hosted.layer))),
      ),
  };
};

const deposit = (id: string, amount: number) =>
  Effect.gen(function* () {
    const accounts = yield* Account;
    yield* accounts.send(Account.ref(id), new Deposit({ amount }));
  });

const amounts = (id: string) =>
  Effect.gen(function* () {
    const view = yield* Deposits;
    return Option.getOrUndefined(yield* view.query(Account.ref(id)))?.amounts;
  });

describe("Domain catch-up", () => {
  it.live(
    "a view that reads more sources without a version bump fails the deploy; with one, it is rebuilt from all of them",
    () =>
      Effect.gen(function* () {
        const bank = platform();
        yield* bank.deploy(
          Before,
          Layer.empty,
          Effect.gen(function* () {
            yield* deposit("a-1", 10);
            const journals = yield* Journal;
            yield* journals.send(Journal.ref("j-1"), new Log({ note: "opened" }));
          }),
        );
        yield* bank.deploy(WithActivity, Layer.empty, bank.settle);
        // Its backfill read Account only: waiting on it would miss the journal's history.
        const refused = yield* bank.deploy(WithWideActivity, Layer.empty, Effect.void).pipe(
          Effect.as(""),
          Effect.catchCause((cause) => Effect.succeed(String(cause))),
        );
        expect(refused).toContain("BackfillPlanChanged");
        expect(refused).toContain("Bump its version");
        const entries = yield* bank.deploy(
          WithWideActivityV1,
          Layer.empty,
          Effect.gen(function* () {
            yield* bank.settle;
            const view = yield* WideActivityV1;
            return Option.getOrUndefined(yield* view.query("all"))?.entries;
          }),
        );
        expect([...(entries ?? [])].sort()).toEqual(["deposit 10", "log opened"]);
      }).pipe(Effect.provide(platform().services)),
  );

  it.live("a view added later folds the events recorded before it", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(
        Before,
        Layer.empty,
        Effect.all([deposit("a-1", 10), deposit("a-1", 20), deposit("a-2", 5)]),
      );
      const [a1, a2] = yield* bank.deploy(
        WithView,
        OnDepositLive,
        Effect.gen(function* () {
          yield* bank.settle;
          return [yield* amounts("a-1"), yield* amounts("a-2")] as const;
        }),
      );
      expect(a1).toEqual([10, 20]);
      expect(a2).toEqual([5]);
    }).pipe(Effect.provide(platform().services)),
  );

  it.live("events committed while a view catches up arrive after its history", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(Before, Layer.empty, Effect.all([deposit("a-1", 1), deposit("a-1", 2)]));
      const result = yield* bank.deploy(
        WithView,
        OnDepositLive,
        // The sweep is queued but not run yet: this commit lands first.
        deposit("a-1", 3).pipe(
          Effect.andThen(bank.settle),
          Effect.andThen(deposit("a-1", 4)),
          Effect.andThen(bank.settle),
          Effect.andThen(amounts("a-1")),
        ),
      );
      expect(result).toEqual([1, 2, 3, 4]);
    }).pipe(Effect.provide(platform().services)),
  );

  it.live("policies never act on replayed history", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(Before, Layer.empty, Effect.all([deposit("a-1", 1), deposit("a-2", 2)]));
      const reactions = yield* bank.deploy(
        WithView,
        OnDepositLive,
        Effect.gen(function* () {
          yield* bank.settle;
          const replayed = yield* Ref.get(yield* Reactions);
          yield* deposit("a-1", 3);
          yield* bank.settle;
          return { replayed, live: (yield* Ref.get(yield* Reactions)) - replayed };
        }),
      );
      expect(reactions).toEqual({ replayed: 0, live: 1 });
    }).pipe(Effect.provide(platform().services)),
  );

  it.live("a view removed, then added back with a new version, is rebuilt with everything", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(WithView, OnDepositLive, deposit("a-1", 1));
      yield* bank.deploy(Before, Layer.empty, deposit("a-1", 2));
      const result = yield* bank.deploy(
        WithViewV1,
        Layer.empty,
        bank.settle.pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const view = yield* DepositsV1;
              return Option.getOrUndefined(yield* view.query(Account.ref("a-1")))?.amounts;
            }),
          ),
        ),
      );
      expect(result).toEqual([1, 2]);
    }).pipe(Effect.provide(platform().services)),
  );

  it.live("a redeploy does not replay history to a view that has it", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(WithView, OnDepositLive, deposit("a-1", 1));
      const result = yield* bank.deploy(
        WithView,
        OnDepositLive,
        deposit("a-1", 2).pipe(Effect.andThen(bank.settle), Effect.andThen(amounts("a-1"))),
      );
      expect(result).toEqual([1, 2]);
      expect(yield* Ref.get(yield* Reactions)).toBe(2);
    }).pipe(Effect.provide(platform().services)),
  );

  it.live("a projection added later receives many instances' history in time order", () =>
    Effect.gen(function* () {
      const bank = platform();
      const at = <R>(hours: number, effect: Effect.Effect<void, never, R>) =>
        Effect.sync(() => {
          bank.clock.now = hours * HOUR;
        }).pipe(Effect.andThen(effect));
      const log = (id: string, note: string) =>
        Effect.gen(function* () {
          yield* (yield* Journal).send(Journal.ref(id), new Log({ note }));
        });
      yield* bank.deploy(
        Before,
        Layer.empty,
        Effect.all([
          at(0, deposit("a-1", 1)),
          at(1, log("j-1", "one")),
          at(3, deposit("a-1", 3)),
          at(4, log("j-1", "four")),
          at(6, deposit("a-2", 6)),
        ]),
      );
      const feed = yield* bank.deploy(
        WithTimeline,
        TimelineLive,
        bank.settle.pipe(Effect.andThen(Effect.flatMap(Feed, Ref.get))),
      );
      // Each instance alone would replay all of its history at once:
      // deposit 1, deposit 3, log one, log four.
      expect(feed).toEqual(["deposit 1", "log one", "deposit 3", "log four", "deposit 6"]);
    }).pipe(Effect.provide(platform().services)),
  );

  it.live("a new view's history says when it is complete", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(Before, Layer.empty, deposit("a-1", 1));
      const [before, after] = yield* bank.deploy(
        WithView,
        OnDepositLive,
        Effect.gen(function* () {
          const view = yield* Deposits;
          const before = yield* view.history;
          yield* bank.settle;
          return [before, yield* view.history] as const;
        }),
      );
      expect(before.complete).toBe(false);
      expect(after.complete).toBe(true);
    }).pipe(Effect.provide(platform().services)),
  );

  it.live("instances created and written while a view catches up are folded once", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(Before, Layer.empty, Effect.all([deposit("a-1", 1), deposit("a-2", 2)]));
      const result = yield* bank.deploy(
        WithView,
        OnDepositLive,
        Effect.gen(function* () {
          // Before the sweep runs: a new instance, and a write to an inactive one.
          yield* deposit("a-9", 9);
          yield* deposit("a-2", 3);
          yield* bank.settle;
          return [yield* amounts("a-1"), yield* amounts("a-2"), yield* amounts("a-9")];
        }),
      );
      expect(result).toEqual([[1], [2, 3], [9]]);
    }).pipe(Effect.provide(platform().services)),
  );

  it.live("a catch-up started again after an interrupted deploy delivers each event once", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(Before, Layer.empty, Effect.all([deposit("a-1", 1), deposit("a-1", 2)]));
      // The first deploy with the view is replaced before its catch-up runs; both sweeps run.
      const first = WithView.layer(OnDepositLive).pipe(Layer.provide(bank.hosted.layer));
      yield* Effect.provide(Effect.void, first);
      const result = yield* bank.deploy(
        WithView,
        OnDepositLive,
        bank.settle.pipe(Effect.andThen(amounts("a-1"))),
      );
      expect(result).toEqual([1, 2]);
      expect(yield* Ref.get(yield* Reactions)).toBe(0);
    }).pipe(Effect.provide(platform().services)),
  );

  it.live("bumping a view's version rebuilds it from the history", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(
        WithView,
        OnDepositLive,
        Effect.all([deposit("a-1", 1), deposit("a-1", 2)]),
      );
      const doubled = (id: string) =>
        Effect.gen(function* () {
          const view = yield* DoubledDeposits;
          return Option.getOrUndefined(yield* view.query(Account.ref(id)))?.amounts;
        });
      // Redefined but not rebuilt: only new deposits are doubled, after the old state.
      const stale = yield* bank.deploy(
        Redefined,
        Layer.empty,
        deposit("a-1", 3).pipe(Effect.andThen(bank.settle), Effect.andThen(doubled("a-1"))),
      );
      expect(stale).toEqual([1, 2, 6]);
      // Keyed by its account: rebuilt in place. Nothing to wait for; each key
      // reads its account's events again before it answers.
      const rebuilt = yield* bank.deploy(
        RedefinedV1,
        Layer.empty,
        Effect.gen(function* () {
          const view = yield* DoubledDepositsV1;
          expect((yield* view.history).complete).toBe(true);
          const first = Option.getOrUndefined(yield* view.query(Account.ref("a-1")))?.amounts;
          expect(first).toEqual([2, 4, 6]);
          yield* deposit("a-1", 4);
          yield* bank.settle;
          return Option.getOrUndefined(yield* view.query(Account.ref("a-1")))?.amounts;
        }),
      );
      expect(rebuilt).toEqual([2, 4, 6, 8]);
      // A policy on the old view acted on the first two deposits only, never on the rebuild.
      expect(yield* Ref.get(yield* Reactions)).toBe(2);
    }).pipe(Effect.provide(platform().services)),
  );

  it.live("bumping a projection's version runs it again over the history", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(
        WithTimeline,
        TimelineLive,
        Effect.all([deposit("a-1", 1), deposit("a-2", 2)]),
      );
      const feed = yield* bank.deploy(
        WithTimeline,
        timelineLayer({ version: 1 }),
        bank.settle.pipe(Effect.andThen(Effect.flatMap(Feed, Ref.get))),
      );
      expect(feed).toEqual(["deposit 1", "deposit 2", "deposit 1", "deposit 2"]);
    }).pipe(Effect.provide(platform().services)),
  );
});
