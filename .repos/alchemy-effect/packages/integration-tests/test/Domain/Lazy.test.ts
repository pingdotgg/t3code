import * as Domain from "@alchemy.run/domain";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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

/** Every deposit to an account: keyed by the account, so a key's history is its own. */
class Deposits extends Domain.View("Deposits", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ amounts: Schema.Array(Schema.Number) }),
  initial: { amounts: [] },
  evolve: { Deposited: (s, e) => ({ amounts: [...s.amounts, e.amount] }) },
}) {}

/** Every deposit across every account: one key fed by every account. */
class Activity extends Domain.View("Activity", {
  from: [Account],
  key: Schema.String,
  keyOf: { Deposited: () => "all" },
  state: Schema.Struct({ count: Schema.Number }),
  initial: { count: 0 },
  evolve: { Deposited: (s) => ({ count: s.count + 1 }) },
}) {}

class Before extends Domain.Model("Bank", { aggregates: [Account] }) {}
class WithDeposits extends Domain.Model("Bank", { aggregates: [Account], views: [Deposits] }) {}
class WithActivity extends Domain.Model("Bank", { aggregates: [Account], views: [Activity] }) {}

/**
 * An in-memory platform that outlives the models built on it, as storage
 * outlives a deploy. It delivers only when drained, so a read before `settle`
 * sees only what the read itself fetched.
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
      model: { readonly layer: (policies: any, options?: any) => Layer.Layer<any, any, any> },
      effect: Effect.Effect<A, E, R>,
      options?: Domain.Model.LayerOptions,
    ) =>
      effect.pipe(
        Effect.tap(() => settle),
        Effect.provide(model.layer(Layer.empty, options).pipe(Layer.provide(hosted.layer))),
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

const history = [deposit("a-1", 1), deposit("a-1", 2), deposit("a-2", 5)];

describe("Domain lazy views", () => {
  it.live("a lazy view's key reads its history the first time it is read", () =>
    Effect.gen(function* () {
      const bank = platform();
      yield* bank.deploy(Before, Effect.all(history));
      const [complete, first, other, after] = yield* bank.deploy(
        WithDeposits,
        Effect.gen(function* () {
          // Nothing delivered yet: the read fetches the key's own history.
          const { complete } = yield* (yield* Deposits).history;
          const first = yield* amounts("a-1");
          const other = yield* amounts("a-2");
          yield* deposit("a-1", 3);
          yield* bank.settle;
          return [complete, first, other, yield* amounts("a-1")] as const;
        }),
        { lazy: ["Deposits"] },
      );
      expect(complete).toBe(true);
      expect(first).toEqual([1, 2]);
      expect(other).toEqual([5]);
      expect(after).toEqual([1, 2, 3]);
    }),
  );

  it.live(
    "an eager view is filled by the deploy: its history is complete once that is delivered",
    () =>
      Effect.gen(function* () {
        const bank = platform();
        yield* bank.deploy(Before, Effect.all(history));
        const [before, after, amountsAfter] = yield* bank.deploy(
          WithDeposits,
          Effect.gen(function* () {
            const view = yield* Deposits;
            const before = (yield* view.history).complete;
            yield* bank.settle;
            return [before, (yield* view.history).complete, yield* amounts("a-1")] as const;
          }),
        );
        expect(before).toBe(false);
        expect(after).toBe(true);
        expect(amountsAfter).toEqual([1, 2]);
      }),
  );

  it.live("a view not keyed by its one source can't be lazy", () =>
    Effect.gen(function* () {
      const bank = platform();
      const exit = yield* bank
        .deploy(WithActivity, Effect.void, { lazy: ["Activity"] })
        .pipe(Effect.exit);
      expect(String(exit)).toContain("Activity can't be lazy");
    }),
  );
});
