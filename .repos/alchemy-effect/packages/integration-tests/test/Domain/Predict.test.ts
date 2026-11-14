import * as Domain from "@alchemy.run/domain";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

// Who operates the bank: what a session middleware would provide.
class Operator extends Domain.RequestContext<Operator>()("Test/Operator", Schema.String) {}
class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class OperatorSession extends RpcMiddleware.Service<OperatorSession, { provides: Operator }>()(
  "Test/OperatorSession",
  { error: Unauthenticated },
) {}

class Opened extends Domain.Event("Opened", { owner: Schema.String, at: Schema.Number }) {}
class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Withdrawn extends Domain.Event("Withdrawn", { amount: Schema.Number }) {}
class Frozen extends Domain.Event("Frozen", { by: Schema.String }) {}
class Stamped extends Domain.Event("Stamped", {
  commandId: Schema.String,
  stream: Schema.String,
  version: Schema.Number,
}) {}

class InsufficientFunds extends Domain.Rejection("InsufficientFunds", {
  balance: Schema.Number,
  requested: Schema.Number,
}) {}
class NotAnOperator extends Domain.Rejection("NotAnOperator") {}

class Open extends Domain.Command("Open", {
  target: Schema.String,
  input: { owner: Schema.String },
  events: [Opened],
}) {}
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
}) {}
class Withdraw extends Domain.Command("Withdraw", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Withdrawn],
  rejects: [InsufficientFunds],
}) {}
// Reads the operator, so a client predicts it only with the operator in context.
class Freeze extends Domain.Command("Freeze", {
  target: Schema.String,
  events: [Frozen],
  rejects: [NotAnOperator],
  middleware: [OperatorSession],
}) {}
// Records what decide is told about the command and the stream.
class Stamp extends Domain.Command("Stamp", { target: Schema.String, events: [Stamped] }) {}

const AccountState = Schema.Struct({
  owner: Schema.String,
  balance: Schema.Number,
  frozen: Schema.Boolean,
});

class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: AccountState,
  initial: { owner: "", balance: 0, frozen: false },
  commands: [Open, Deposit, Withdraw, Freeze, Stamp],
  decide: {
    Open: (_, { owner }, { now }) => [new Opened({ owner, at: DateTime.toEpochMillis(now) })],
    Deposit: (_, { amount }) => [new Deposited({ amount })],
    Withdraw: (s, { amount }) =>
      amount > s.balance
        ? new InsufficientFunds({ balance: s.balance, requested: amount })
        : [new Withdrawn({ amount })],
    Freeze: Effect.fn(function* () {
      const operator = yield* Operator;
      if (operator === "guest") return yield* new NotAnOperator();
      return [new Frozen({ by: operator })];
    }),
    Stamp: (_, __, { commandId, stream, version }) => [new Stamped({ commandId, stream, version })],
  },
  evolve: {
    Opened: (s, e) => ({ ...s, owner: e.owner }),
    Deposited: (s, e) => ({ ...s, balance: s.balance + e.amount }),
    Withdrawn: (s, e) => ({ ...s, balance: s.balance - e.amount }),
    Frozen: (s) => ({ ...s, frozen: true }),
    Stamped: (s) => s,
  },
}) {}

class Moved extends Domain.Event("Moved", {
  from: Schema.String,
  to: Schema.String,
  amount: Schema.Number,
}) {}
class Move extends Domain.Command("Move", {
  target: Schema.String,
  input: { from: Schema.String, to: Schema.String, amount: Schema.Number },
  events: [Moved],
}) {}
class Transfer extends Domain.Aggregate("Transfer", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Move],
  decide: { Move: (_, { from, to, amount }) => [new Moved({ from, to, amount })] },
  evolve: { Moved: (s) => s },
}) {}

class Balance extends Domain.View("Balance", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ balance: Schema.Number, lines: Schema.Number }),
  initial: { balance: 0, lines: 0 },
  evolve: {
    Deposited: (s, e) => ({ balance: s.balance + e.amount, lines: s.lines + 1 }),
    Withdrawn: (s, e) => ({ balance: s.balance - e.amount, lines: s.lines + 1 }),
  },
}) {}

// One transfer updates two keys: the sender's as `out`, the recipient's as `in`.
class Flows extends Domain.View("Flows", {
  from: [Transfer],
  key: Account,
  keyOf: {
    Moved: {
      out: ({ event }) => Account.ref(event.from),
      in: ({ event }) => Account.ref(event.to),
    },
  },
  state: Schema.Struct({ net: Schema.Number }),
  initial: { net: 0 },
  evolve: {
    Moved: {
      out: (s, e) => ({ net: s.net - e.amount }),
      in: (s, e) => ({ net: s.net + e.amount }),
    },
  },
}) {}

// Keyed by the sender's id itself, a Schema key with no aggregate behind it.
class Sent extends Domain.View("Sent", {
  from: [Transfer],
  key: Schema.String,
  keyOf: { Moved: ({ event }) => event.from },
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: { Moved: (s, e) => ({ total: s.total + e.amount }) },
}) {}

class Bank extends Domain.Model("Bank", {
  aggregates: [Account, Transfer],
  views: [Balance, Flows, Sent],
}) {}

// A decide that waits on something asynchronous, and one that breaks its declaration.
class Waited extends Domain.Event("Waited") {}
class Wait extends Domain.Command("Wait", { target: Schema.String, events: [Waited] }) {}
class Stray extends Domain.Command("Stray", { target: Schema.String, events: [Waited] }) {}
class Later extends Domain.Aggregate("Later", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Wait, Stray],
  decide: {
    Wait: () => Effect.promise(() => Promise.resolve([new Waited()])),
    Stray: () => [new Frozen({ by: "nobody" })] as never,
  },
  evolve: { Waited: (s) => s },
}) {}

class Strays extends Domain.Model("Strays", { aggregates: [Later] }) {}

const NOW = 1_800_000_000_000;
const Hosted = Bank.layer(Layer.empty).pipe(
  Layer.provide(Layer.suspend(() => InMemory.make({ now: () => NOW }).layer)),
);
const now = DateTime.makeUnsafe(NOW);
const a1 = Account.ref("a-1");

/** The server's answer to a command: its events, or its rejection, and the state after it. */
const serve = (command: Domain.Aggregate.CommandOf<typeof Account>, operator = "sam") =>
  Effect.gen(function* () {
    const accounts = yield* Account;
    const result = yield* accounts
      .send(a1, command, { commandId: `c-${command._tag}` })
      .pipe(Effect.provideService(Operator, operator), Effect.result);
    return { result, state: yield* accounts.state(a1) };
  });

describe("Domain Aggregate.predict", { tags: ["unit", "local"] }, () => {
  it.live("an accepted command: the same events and state as the server", () =>
    Effect.gen(function* () {
      const accounts = yield* Account;
      yield* accounts.send(a1, new Open({ owner: "sam" }));
      const before = yield* accounts.state(a1);
      const command = new Deposit({ amount: 30 });
      const local = Account.predict(before, command, { id: "a-1", now, version: 1 });
      const remote = yield* serve(command);

      expect(local._tag).toBe("Accepted");
      if (local._tag !== "Accepted" || remote.result._tag !== "Success") return;
      expect(local.events).toEqual(remote.result.success.events);
      expect(local.state).toEqual(remote.state);
      expect(local.envelopes.map((e) => [e.stream, e.seq])).toEqual([["Account/a-1", 2]]);
    }).pipe(Effect.provide(Hosted)),
  );

  it.live("a rejected command: the same rejection as the server", () =>
    Effect.gen(function* () {
      const accounts = yield* Account;
      const before = yield* accounts.state(a1);
      const command = new Withdraw({ amount: 5 });
      const local = Account.predict(before, command, { id: "a-1", now });
      const remote = yield* serve(command);

      expect(local._tag).toBe("Rejected");
      expect(remote.result._tag).toBe("Failure");
      if (local._tag !== "Rejected" || remote.result._tag !== "Failure") return;
      expect(local.rejection).toBeInstanceOf(InsufficientFunds);
      expect(local.rejection).toEqual(remote.result.failure);
      // The rejection is a value, typed by the command's `rejects`.
      const typed: InsufficientFunds = local.rejection;
      expect(typed.requested).toBe(5);
    }).pipe(Effect.provide(Hosted)),
  );

  it.effect("decide sees the id and time the caller gives", () =>
    Effect.sync(() => {
      const local = Account.predict(Account.definition.initial, new Open({ owner: "sam" }), {
        id: "a-1",
        now,
        commandId: "c-1",
      });
      expect(local).toMatchObject({
        _tag: "Accepted",
        events: [new Opened({ owner: "sam", at: NOW })],
        envelopes: [{ id: "a-1", seq: 1, commandId: "c-1", correlationId: "c-1" }],
      });
    }),
  );

  it.live("the server's decide sees the command id, stream and version before it", () =>
    Effect.gen(function* () {
      const accounts = yield* Account;
      yield* accounts.send(a1, new Open({ owner: "sam" }));
      const remote = yield* serve(new Stamp());

      expect(remote.result._tag).toBe("Success");
      if (remote.result._tag !== "Success") return;
      expect(remote.result.success.events).toEqual([
        new Stamped({ commandId: "c-Stamp", stream: "Account/a-1", version: 1 }),
      ]);
    }).pipe(Effect.provide(Hosted)),
  );

  it.effect("decide sees the command id and version the caller gives", () =>
    Effect.sync(() => {
      const local = Account.predict(Account.definition.initial, new Stamp(), {
        id: "a-1",
        now,
        version: 1,
        commandId: "c-Stamp",
      });
      expect(local).toMatchObject({
        _tag: "Accepted",
        events: [new Stamped({ commandId: "c-Stamp", stream: "Account/a-1", version: 1 })],
      });
    }),
  );

  it.effect("decide sees version 0 and an empty command id when the caller gives none", () =>
    Effect.sync(() => {
      const local = Account.predict(Account.definition.initial, new Stamp(), { id: "a-1", now });
      expect(local).toMatchObject({
        _tag: "Accepted",
        events: [new Stamped({ commandId: "", stream: "Account/a-1", version: 0 })],
      });
    }),
  );

  it.effect("a command with middleware needs what its middleware provides", () =>
    Effect.sync(() => {
      const state = Account.definition.initial;
      // @ts-expect-error Freeze's middleware provides Operator: pass it as context
      const unknown = Account.predict(state, new Freeze(), { id: "a-1", now });
      expect(unknown._tag).toBe("Unpredictable");

      const operator = (name: string) => ({
        id: "a-1",
        now,
        context: Context.make(Operator, name),
      });
      expect(Account.predict(state, new Freeze(), operator("sam"))).toMatchObject({
        _tag: "Accepted",
        events: [new Frozen({ by: "sam" })],
      });
      const refused = Account.predict(state, new Freeze(), operator("guest"));
      expect(refused._tag).toBe("Rejected");
      if (refused._tag === "Rejected") expect(refused.rejection).toBeInstanceOf(NotAnOperator);
    }),
  );

  it.effect("a decide that suspends cannot be predicted, and does not hang", () =>
    Effect.sync(() => {
      const local = Later.predict({}, new Wait(), { id: "l-1", now });
      expect(local._tag).toBe("Unpredictable");
    }),
  );

  it.effect("an undeclared event cannot be predicted: the cause holds a DefinitionError", () =>
    Effect.sync(() => {
      const local = Later.predict({}, new Stray(), { id: "l-1", now });
      expect(local._tag).toBe("Unpredictable");
      if (local._tag !== "Unpredictable") return;
      expect(Cause.squash(local.cause)).toMatchObject({
        _tag: "DefinitionError",
        message: "Later.decide.Stray returned 'Frozen', which Stray does not declare in events",
      });
    }),
  );

  it.live("the server dies on the same undeclared event", () =>
    Effect.gen(function* () {
      const later = yield* Later;
      const exit = yield* later.send(Later.ref("l-1"), new Stray()).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "DefinitionError",
        message: "Later.decide.Stray returned 'Frozen', which Stray does not declare in events",
      });
    }).pipe(
      Effect.provide(
        Strays.layer(Layer.empty).pipe(
          Layer.provide(Layer.suspend(() => InMemory.make({ now: () => NOW }).layer)),
        ),
      ),
    ),
  );

  it.effect("a client-side Layer provides the middleware's context", () =>
    Effect.gen(function* () {
      // The server's OperatorSession reads a header; the client knows who it is.
      const ClientSession = Layer.succeed(Operator, "sam");
      const context = yield* Layer.build(ClientSession);
      const local = Account.predict(Account.definition.initial, new Freeze(), {
        id: "a-1",
        now,
        context,
      });
      expect(local).toMatchObject({ _tag: "Accepted", events: [new Frozen({ by: "sam" })] });
    }).pipe(Effect.scoped),
  );
});

describe("Domain View.evolve", { tags: ["unit", "local"] }, () => {
  it.live("predicted events folded by the view give the server's view state", () =>
    Effect.gen(function* () {
      const accounts = yield* Account;
      const balances = yield* Balance;
      yield* accounts.send(a1, new Deposit({ amount: 50 }));
      const before = yield* accounts.state(a1);
      const view = yield* balances.query(a1, { atLeast: { stream: "Account/a-1", version: 1 } });

      const local = Account.predict(before, new Withdraw({ amount: 20 }), {
        id: "a-1",
        now,
        version: 1,
      });
      if (local._tag !== "Accepted") return expect(local._tag).toBe("Accepted");
      const predicted = local.events.reduce(
        (state, event, index) =>
          Balance.evolve(state, {
            name: "Account",
            event,
            source: a1,
            envelope: local.envelopes[index]!,
          }),
        Option.getOrNull(view),
      );

      const receipt = yield* accounts.send(a1, new Withdraw({ amount: 20 }));
      const server = yield* balances.query(a1, {
        atLeast: { stream: receipt.stream, version: receipt.version },
      });
      expect(predicted).toEqual({ balance: 30, lines: 2 });
      expect(Option.getOrNull(server)).toEqual(predicted);
    }).pipe(Effect.provide(Hosted)),
  );

  it.live("a routed view applies each route that reaches the key", () =>
    Effect.gen(function* () {
      const transfers = yield* Transfer;
      const flows = yield* Flows;
      const command = new Move({ from: "a-1", to: "a-2", amount: 7 });
      const local = Transfer.predict(Transfer.definition.initial, command, { id: "t-1", now });
      if (local._tag !== "Accepted") return expect(local._tag).toBe("Accepted");
      const fold = (key: string) =>
        Flows.evolve(null, {
          name: "Transfer",
          event: local.events[0]!,
          source: Transfer.ref("t-1"),
          envelope: local.envelopes[0]!,
          key: Account.ref(key),
        });

      const receipt = yield* transfers.send(Transfer.ref("t-1"), command);
      const atLeast = { stream: receipt.stream, version: receipt.version };
      expect(fold("a-1")).toEqual({ net: -7 });
      expect(fold("a-2")).toEqual({ net: 7 });
      // A key no route reaches keeps its state.
      expect(fold("a-3")).toBeNull();
      const server = (key: string) =>
        flows.query(Account.ref(key), { atLeast }).pipe(Effect.map(Option.getOrNull));
      expect(yield* server("a-1")).toEqual(fold("a-1"));
      expect(yield* server("a-2")).toEqual(fold("a-2"));
    }).pipe(Effect.provide(Hosted)),
  );

  it.live("a view keyed by a Schema value applies only the key keyOf returns", () =>
    Effect.gen(function* () {
      const transfers = yield* Transfer;
      const sent = yield* Sent;
      const command = new Move({ from: "a-1", to: "a-2", amount: 5 });
      const local = Transfer.predict(Transfer.definition.initial, command, { id: "t-2", now });
      if (local._tag !== "Accepted") return expect(local._tag).toBe("Accepted");
      const fold = (key: string) =>
        Sent.evolve(null, {
          name: "Transfer",
          event: local.events[0]!,
          source: Transfer.ref("t-2"),
          envelope: local.envelopes[0]!,
          key,
        });

      const receipt = yield* transfers.send(Transfer.ref("t-2"), command);
      const atLeast = { stream: receipt.stream, version: receipt.version };
      expect(fold("a-1")).toEqual({ total: 5 });
      expect(fold("a-2")).toBeNull();
      expect(Option.getOrNull(yield* sent.query("a-1", { atLeast }))).toEqual(fold("a-1"));
    }).pipe(Effect.provide(Hosted)),
  );
});
