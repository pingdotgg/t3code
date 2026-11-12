import * as Domain from "@alchemy.run/domain";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Withdrawn extends Domain.Event("Withdrawn", { amount: Schema.Number }) {}
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
}) {}
class Withdraw extends Domain.Command("Withdraw", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Withdrawn],
}) {}
class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit, Withdraw],
  decide: {
    Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })],
    Withdraw: (_, cmd) => [new Withdrawn({ amount: cmd.amount })],
  },
  evolve: {
    Deposited: (s, e) => ({ balance: s.balance + e.amount }),
    Withdrawn: (s, e) => ({ balance: s.balance - e.amount }),
  },
}) {}

const Net = Schema.Struct({ net: Schema.Number });

/** One row per account, counting deposits only: the version 0 the model deployed first. */
class Summary extends Domain.View("Summary", {
  from: [Account],
  key: Account,
  state: Net,
  initial: { net: 0 },
  evolve: { Deposited: (s, e) => ({ net: s.net + e.amount }) },
}) {}
/** Fixed to count withdrawals too, an event its keys never received: version 1. */
class SummaryV1 extends Domain.View("Summary", {
  from: [Account],
  key: Account,
  state: Net,
  initial: { net: 0 },
  evolve: {
    Deposited: (s, e) => ({ net: s.net + e.amount }),
    Withdrawn: (s, e) => ({ net: s.net - e.amount }),
  },
  version: 1,
}) {}

/** One row for every account: fed by many instances. */
const Total = Schema.Struct({ total: Schema.Number });
class Totals extends Domain.View("Totals", {
  from: [Account],
  key: Schema.String,
  keyOf: { Deposited: () => "all" },
  state: Total,
  initial: { total: 0 },
  evolve: { Deposited: (s, e) => ({ total: s.total + e.amount }) },
}) {}
class TotalsV1 extends Domain.View("Totals", {
  from: [Account],
  key: Schema.String,
  keyOf: { Deposited: () => "all" },
  state: Total,
  initial: { total: 0 },
  evolve: { Deposited: (s, e) => ({ total: s.total + e.amount * 10 }) },
  version: 1,
}) {}

/** Each account's latest net: built on `Summary`, so rebuilt from its rows. */
class Latest extends Domain.View("Latest", {
  from: [Summary],
  key: Account,
  state: Net,
  initial: { net: 0 },
  evolve: { Deposited: (_, __, { state }) => ({ net: state?.net ?? 0 }) },
}) {}
class LatestOfV1 extends Domain.View("Latest", {
  from: [SummaryV1],
  key: Account,
  state: Net,
  initial: { net: 0 },
  evolve: {
    Deposited: (_, __, { state }) => ({ net: state?.net ?? 0 }),
    Withdrawn: (_, __, { state }) => ({ net: state?.net ?? 0 }),
  },
}) {}

class Bank extends Domain.Model("Bank", {
  aggregates: [Account],
  views: [Summary, Totals, Latest],
}) {}
class BankV1 extends Domain.Model("Bank", {
  aggregates: [Account],
  views: [SummaryV1, TotalsV1, LatestOfV1],
}) {}

/**
 * An in-memory platform that outlives the models built on it, as storage
 * outlives a deploy. It delivers only when drained.
 */
const platform = () => {
  const hosted = InMemory.make({ manual: true });
  const settle: Effect.Effect<void> = Effect.gen(function* () {
    while (true) {
      yield* hosted.control.drain;
      if (yield* hosted.control.idle) return;
      yield* Effect.sleep("1 millis");
    }
  });
  return {
    settle,
    deploy: <A, E, R>(
      model: { readonly layer: (policies: any) => Layer.Layer<any, any, any> },
      effect: Effect.Effect<A, E, R>,
    ) =>
      effect.pipe(
        Effect.tap(() => settle),
        Effect.provide(model.layer(Layer.empty).pipe(Layer.provide(hosted.layer))),
      ),
  };
};

const send = (id: string, command: Deposit | Withdraw) =>
  Effect.gen(function* () {
    const accounts = yield* Account;
    yield* accounts.send(Account.ref(id), command);
  });

const history = [
  send("a-1", new Deposit({ amount: 10 })),
  send("a-1", new Withdraw({ amount: 4 })),
  send("a-2", new Deposit({ amount: 3 })),
];

describe("Domain view versions", () => {
  it.live(
    "a view keyed by its aggregate is rebuilt in place: each key reads its events again",
    () =>
      Effect.gen(function* () {
        const bank = platform();
        yield* bank.deploy(Bank, Effect.all(history));
        const [complete, a1, a2] = yield* bank.deploy(
          BankV1,
          Effect.gen(function* () {
            const view = yield* SummaryV1;
            // Nothing to wait for, before anything is delivered.
            const { complete } = yield* view.history;
            const a1 = Option.getOrUndefined(yield* view.query(Account.ref("a-1")));
            const a2 = Option.getOrUndefined(yield* view.query(Account.ref("a-2")));
            return [complete, a1, a2] as const;
          }),
        );
        expect(complete).toBe(true);
        // The withdrawal, which the old view never received, counts.
        expect(a1).toEqual({ net: 6 });
        expect(a2).toEqual({ net: 3 });
      }),
  );

  it.live("a view fed by many instances is rebuilt from the history", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(Bank, Effect.all(history));
      const [before, after, total] = yield* bank.deploy(
        BankV1,
        Effect.gen(function* () {
          const view = yield* TotalsV1;
          const before = (yield* view.history).complete;
          yield* bank.settle;
          return [
            before,
            (yield* view.history).complete,
            Option.getOrUndefined(yield* view.query("all")),
          ] as const;
        }),
      );
      expect(before).toBe(false);
      expect(after).toBe(true);
      expect(total).toEqual({ total: 130 });
    }),
  );

  it.live("a view built on a rebuilt view is rebuilt from its new rows", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(Bank, Effect.all(history));
      expect(
        yield* bank.deploy(
          Bank,
          bank.settle.pipe(
            Effect.andThen(
              Effect.gen(function* () {
                return yield* (yield* Latest).query(Account.ref("a-1"));
              }),
            ),
          ),
        ),
      ).toEqual(Option.some({ net: 10 }));
      // No key of SummaryV1 is read first: Latest's rebuild reads them, and each
      // has its new rows before it answers.
      const top = yield* bank.deploy(
        BankV1,
        Effect.gen(function* () {
          yield* bank.settle;
          return Option.getOrUndefined(yield* (yield* LatestOfV1).query(Account.ref("a-1")));
        }),
      );
      expect(top).toEqual({ net: 6 });
    }),
  );
  it.live("an account opened after the bump fills its rebuilt row", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(Bank, Effect.all(history));
      const fresh = yield* bank.deploy(
        BankV1,
        Effect.gen(function* () {
          yield* send("a-9", new Deposit({ amount: 7 }));
          yield* send("a-9", new Withdraw({ amount: 2 }));
          yield* bank.settle;
          return Option.getOrUndefined(yield* (yield* SummaryV1).query(Account.ref("a-9")));
        }),
      );
      expect(fresh).toEqual({ net: 5 });
    }),
  );
});
