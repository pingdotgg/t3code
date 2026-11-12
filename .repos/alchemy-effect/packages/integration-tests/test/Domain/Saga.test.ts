import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Activity, DurableClock, DurableDeferred } from "effect/workflow";

// Wallets that a transfer saga debits and credits.
class Opened extends Domain.Event("Opened", { balance: Schema.Number }) {}
class Debited extends Domain.Event("Debited", { transfer: Schema.String, amount: Schema.Number }) {}
class Credited extends Domain.Event("Credited", {
  transfer: Schema.String,
  amount: Schema.Number,
}) {}
class Refunded extends Domain.Event("Refunded", {
  transfer: Schema.String,
  amount: Schema.Number,
}) {}
class Closed extends Domain.Event("Closed") {}

class Insufficient extends Domain.Rejection("Insufficient", { balance: Schema.Number }) {}
class NotOpen extends Domain.Rejection("NotOpen") {}

class Open extends Domain.Command("Open", {
  target: Schema.String,
  input: { balance: Schema.Number },
  events: [Opened],
}) {}
class Close extends Domain.Command("Close", { target: Schema.String, events: [Closed] }) {}
class Debit extends Domain.Command("Debit", {
  target: Schema.String,
  input: { transfer: Schema.String, amount: Schema.Number },
  events: [Debited],
  rejects: [Insufficient],
}) {}
class Credit extends Domain.Command("Credit", {
  target: Schema.String,
  input: { transfer: Schema.String, amount: Schema.Number },
  events: [Credited],
  rejects: [NotOpen],
}) {}
class Refund extends Domain.Command("Refund", {
  target: Schema.String,
  input: { transfer: Schema.String, amount: Schema.Number },
  events: [Refunded],
}) {}

class Wallet extends Domain.Aggregate("Wallet", {
  id: Schema.String,
  state: Schema.Struct({ open: Schema.Boolean, balance: Schema.Number }),
  initial: { open: false, balance: 0 },
  commands: [Open, Close, Debit, Credit, Refund],
  decide: {
    Open: (_, cmd) => [new Opened({ balance: cmd.balance })],
    Close: () => [new Closed()],
    Debit: (s, cmd) =>
      s.balance < cmd.amount
        ? new Insufficient({ balance: s.balance })
        : [new Debited({ transfer: cmd.transfer, amount: cmd.amount })],
    Credit: (s, cmd) =>
      s.open ? [new Credited({ transfer: cmd.transfer, amount: cmd.amount })] : new NotOpen(),
    Refund: (_, cmd) => [new Refunded({ transfer: cmd.transfer, amount: cmd.amount })],
  },
  evolve: {
    Opened: (_, e) => ({ open: true, balance: e.balance }),
    Debited: (s, e) => ({ ...s, balance: s.balance - e.amount }),
    Credited: (s, e) => ({ ...s, balance: s.balance + e.amount }),
    Refunded: (s, e) => ({ ...s, balance: s.balance + e.amount }),
    Closed: (s) => ({ ...s, open: false }),
  },
}) {}

// A transfer is requested on its own aggregate; a policy starts the saga.
class Requested extends Domain.Event("Requested", {
  from: Schema.String,
  to: Schema.String,
  amount: Schema.Number,
  approval: Schema.Boolean,
}) {}
class RequestTransfer extends Domain.Command("RequestTransfer", {
  target: Schema.String,
  input: {
    from: Schema.String,
    to: Schema.String,
    amount: Schema.Number,
    approval: Schema.Boolean,
  },
  events: [Requested],
}) {}
class Transfer extends Domain.Aggregate("Transfer", {
  id: Schema.String,
  state: Schema.Struct({ requested: Schema.Boolean }),
  initial: { requested: false },
  commands: [RequestTransfer],
  decide: {
    RequestTransfer: (s, cmd) =>
      s.requested
        ? []
        : [
            new Requested({
              from: cmd.from,
              to: cmd.to,
              amount: cmd.amount,
              approval: cmd.approval,
            }),
          ],
  },
  evolve: { Requested: () => ({ requested: true }) },
}) {}

class DestinationClosed extends Domain.Rejection("DestinationClosed") {}
class NotApproved extends Domain.Rejection("NotApproved") {}

const Approval = DurableDeferred.make("approval", { success: Schema.String });

class MoveMoney extends Domain.Saga("MoveMoney", {
  key: Schema.String,
  input: {
    from: Schema.String,
    to: Schema.String,
    amount: Schema.Number,
    approval: Schema.Boolean,
  },
  result: { approvedBy: Schema.NullOr(Schema.String) },
  rejects: [Insufficient, DestinationClosed, NotApproved],
}) {}

const MoveMoneyLive = MoveMoney.toLayer(
  Effect.gen(function* () {
    const wallets = yield* Wallet;
    return Effect.fn(function* ({ key, from, to, amount, approval }) {
      // Whichever comes first: the approval, or the end of the 24 hour window.
      const approvedBy = approval
        ? yield* DurableDeferred.raceAll({
            name: "approval-window",
            success: Schema.NullOr(Schema.String),
            error: Schema.Never,
            effects: [
              DurableDeferred.await(Approval),
              DurableClock.sleep({ name: "window", duration: "24 hours" }).pipe(Effect.as(null)),
            ],
          })
        : null;
      if (approval && approvedBy === null) return yield* new NotApproved();
      yield* Activity.make({
        name: "debit",
        error: Insufficient,
        execute: wallets.send(from, new Debit({ transfer: key, amount })),
      }).pipe(
        MoveMoney.withCompensation(() =>
          Activity.make({
            name: "refund",
            execute: wallets.send(from, new Refund({ transfer: key, amount })).pipe(Effect.orDie),
          }),
        ),
      );
      yield* Activity.make({
        name: "credit",
        error: DestinationClosed,
        execute: wallets
          .send(to, new Credit({ transfer: key, amount }))
          .pipe(Effect.catchTag("NotOpen", () => Effect.fail(new DestinationClosed()))),
      });
      return { approvedBy };
    });
  }),
);

class StartTransfers extends Domain.Policy("StartTransfers", {
  from: Transfer,
  on: [Requested],
}) {}
const StartTransfersLive = StartTransfers.toLayer(
  Effect.gen(function* () {
    const transfers = yield* MoveMoney;
    return Effect.fn(function* ({ source, event }) {
      yield* transfers.start(source, {
        from: event.from,
        to: event.to,
        amount: event.amount,
        approval: event.approval,
      });
    });
  }),
);

class Bank extends Domain.Model("Bank", {
  aggregates: [Wallet, Transfer],
  policies: [StartTransfers],
  sagas: [MoveMoney],
}) {}

const Handlers = Layer.mergeAll(StartTransfersLive, MoveMoneyLive);

const story = Story.make(Bank, { layer: Handlers });
const alice = Wallet.ref("alice");
const bob = Wallet.ref("bob");
const transfer = Transfer.ref("t-1");
const request = (amount: number, approval = false) =>
  new RequestTransfer({ from: alice.id, to: bob.id, amount, approval });
const requested = (amount: number, approval = false) =>
  new Requested({ from: alice.id, to: bob.id, amount, approval });

// A step that sends a debit, then fails its first attempt: the retry sends the
// same command again, which the wallet must apply once.
class Flaky extends Schema.TaggedError<Flaky>()("Flaky", {}) {}

class DebitTwice extends Domain.Saga("DebitTwice", {
  key: Schema.String,
  input: { from: Schema.String, amount: Schema.Number },
}) {}

const DebitTwiceLive = DebitTwice.toLayer(
  Effect.gen(function* () {
    const wallets = yield* Wallet;
    return Effect.fn(function* ({ key, from, amount }) {
      yield* Activity.make({
        name: "debit",
        error: Flaky,
        execute: Effect.gen(function* () {
          yield* wallets.send(from, new Debit({ transfer: key, amount })).pipe(Effect.orDie);
          if ((yield* Activity.CurrentAttempt) === 1) return yield* new Flaky();
        }),
      }).pipe(Activity.retry({ times: 2 }), Effect.orDie);
    });
  }),
);

class Retries extends Domain.Model("Retries", {
  aggregates: [Wallet],
  sagas: [DebitTwice],
}) {}

// A screening saga that asks an external system, and a saga whose step dies.
class SanctionsDown extends Domain.Rejection("SanctionsDown") {}

class Sanctions extends Domain.ExternalSystem("Sanctions", {
  check: {
    args: { wallet: Schema.String },
    success: { clear: Schema.Boolean },
    error: SanctionsDown,
  },
}) {}

class Flagged extends Domain.Rejection("Flagged") {}
class ScreeningUnavailable extends Domain.Rejection("ScreeningUnavailable") {}

class Screen extends Domain.Saga("Screen", {
  key: Schema.String,
  input: { wallet: Schema.String },
  rejects: [Flagged, ScreeningUnavailable],
}) {}

const ScreenLive = Screen.toLayer(
  Effect.gen(function* () {
    const sanctions = yield* Sanctions;
    return Effect.fn(function* ({ wallet }) {
      const { clear } = yield* Activity.make({
        name: "check",
        success: Schema.Struct({ clear: Schema.Boolean }),
        error: SanctionsDown,
        execute: sanctions.check({ wallet }),
      }).pipe(Effect.catchTag("SanctionsDown", () => Effect.fail(new ScreeningUnavailable())));
      if (!clear) return yield* new Flagged();
      yield* Activity.make({ name: "approve", execute: Effect.void });
    });
  }),
);

class Explode extends Domain.Saga("Explode", {
  key: Schema.String,
  input: {},
}) {}

const ExplodeLive = Explode.toLayer(
  Effect.succeed(() => Activity.make({ name: "boom", execute: Effect.die(new Error("boom")) })),
);

class StartChecks extends Domain.Policy("StartChecks", {
  from: Transfer,
  on: [Requested],
}) {}
const StartChecksLive = StartChecks.toLayer(
  Effect.gen(function* () {
    const screens = yield* Screen;
    const explosions = yield* Explode;
    return Effect.fn(function* ({ source, event }) {
      if (event.approval) yield* explosions.start(source, {});
      else yield* screens.start(source, { wallet: event.from });
    });
  }),
);

class Checks extends Domain.Model("Checks", {
  aggregates: [Wallet, Transfer],
  policies: [StartChecks],
  sagas: [Screen, Explode],
}) {}

const checks = Story.make(Checks, {
  layer: Layer.mergeAll(StartChecksLive, ScreenLive, ExplodeLive),
  stub: [Sanctions],
});

describe("Domain.Saga", { tags: ["unit", "local"] }, () => {
  it.effect("a policy starts a saga that debits and credits", () =>
    story(
      Story.given(alice, new Opened({ balance: 100 })),
      Story.given(bob, new Opened({ balance: 0 })),
      Story.when(transfer, request(40)),
      Story.then(transfer, requested(40)),
      Story.then(alice, new Debited({ transfer: "t-1", amount: 40 })),
      Story.then(bob, new Credited({ transfer: "t-1", amount: 40 })),
      Story.saga(MoveMoney, "t-1", { _tag: "Completed", result: { approvedBy: null } }),
    ),
  );

  it.effect("a failed step undoes the steps before it", () =>
    story(
      Story.given(alice, new Opened({ balance: 100 })),
      Story.given(bob, new Opened({ balance: 0 }), new Closed()),
      Story.when(transfer, request(40)),
      Story.then(transfer, requested(40)),
      Story.then(
        alice,
        new Debited({ transfer: "t-1", amount: 40 }),
        new Refunded({ transfer: "t-1", amount: 40 }),
      ),
      Story.then(bob),
      Story.saga(MoveMoney, "t-1", { _tag: "Rejected", rejection: new DestinationClosed() }),
    ),
  );

  it.effect("a refused first step rejects the saga", () =>
    story(
      Story.given(alice, new Opened({ balance: 10 })),
      Story.given(bob, new Opened({ balance: 0 })),
      Story.when(transfer, request(40)),
      Story.then(transfer, requested(40)),
      Story.then(alice),
      Story.saga(MoveMoney, "t-1", {
        _tag: "Rejected",
        rejection: new Insufficient({ balance: 10 }),
      }),
    ),
  );

  it.effect("a step's external system call waits until the story answers it", () =>
    checks(
      Story.when(transfer, request(40)),
      Story.then(transfer, requested(40)),
      Story.saga(Screen, "t-1", { _tag: "Running" }),
      Story.call(Sanctions.check, { wallet: "alice" }),
      Story.succeed(Sanctions.check, { clear: false }),
      Story.saga(Screen, "t-1", { _tag: "Rejected", rejection: new Flagged() }),
    ),
  );

  it.effect("a step's external system call fails with the operation's declared error", () =>
    checks(
      Story.when(transfer, request(40)),
      Story.then(transfer, requested(40)),
      Story.call(Sanctions.check, { wallet: "alice" }),
      Story.fail(Sanctions.check, new SanctionsDown()),
      Story.saga(Screen, "t-1", { _tag: "Rejected", rejection: new ScreeningUnavailable() }),
    ),
  );

  it.effect("a step's external system call that dies kills the saga", () =>
    checks(
      Story.when(transfer, request(40)),
      Story.then(transfer, requested(40)),
      Story.call("t-1", Sanctions.check, { wallet: "alice" }),
      Story.die("t-1", Sanctions.check, new Error("socket closed")),
      Story.saga(Screen, "t-1", { _tag: "Died" }),
    ),
  );

  it.effect("a saga that dies reads as Died", () =>
    checks(
      Story.when(transfer, request(40, true)),
      Story.then(transfer, requested(40, true)),
      Story.saga(Explode, "t-1", { _tag: "Died" }),
    ),
  );

  it.effect("a saga that dies fails the story unless a step asserts it", () =>
    checks(Story.when(transfer, request(40, true))).pipe(
      Effect.flip,
      Effect.map((failure) =>
        expect(failure.message).toMatch(/saga Explode run t-1 died with Error: boom/),
      ),
    ),
  );

  it.effect("waits for a signal before it runs", () =>
    story(
      Story.given(alice, new Opened({ balance: 100 })),
      Story.given(bob, new Opened({ balance: 0 })),
      Story.when(transfer, request(40, true)),
      Story.then(transfer, requested(40, true)),
      Story.then(alice),
      Story.saga(MoveMoney, "t-1", { _tag: "Running" }),
      Story.signal(MoveMoney, "t-1", Approval, "agent-7"),
      Story.then(alice, new Debited({ transfer: "t-1", amount: 40 })),
      Story.then(bob, new Credited({ transfer: "t-1", amount: 40 })),
      Story.saga(MoveMoney, "t-1", { _tag: "Completed", result: { approvedBy: "agent-7" } }),
    ),
  );

  it.effect("rejects when the wait times out on the story's clock", () =>
    story(
      Story.clock("2026-01-01T09:00:00Z"),
      Story.given(alice, new Opened({ balance: 100 })),
      Story.given(bob, new Opened({ balance: 0 })),
      Story.when(transfer, request(40, true)),
      Story.then(transfer, requested(40, true)),
      Story.clock("2026-01-02T08:59:00Z"),
      Story.saga(MoveMoney, "t-1", { _tag: "Running" }),
      Story.clock("2026-01-02T09:00:00Z"),
      Story.saga(MoveMoney, "t-1", { _tag: "Rejected", rejection: new NotApproved() }),
      Story.then(alice),
    ),
  );

  it.live("a step that runs again sends the same commands", () =>
    Effect.gen(function* () {
      const wallets = yield* Wallet;
      const debits = yield* DebitTwice;
      yield* wallets.send(alice, new Open({ balance: 100 }));
      const run = yield* debits.start("t-1", { from: "alice", amount: 40 });
      yield* run.result;
      // Debited once: the retry's send had the same command id.
      expect((yield* wallets.state(alice)).balance).toBe(60);
    }).pipe(Effect.provide(Retries.layer(DebitTwiceLive).pipe(Layer.provide(InMemory)))),
  );

  // In real time: the client polls while it waits for the result.
  it.live("starting a saga twice runs it once, and its client reads the result", () =>
    Effect.gen(function* () {
      const transfers = yield* MoveMoney;
      const wallets = yield* Wallet;
      yield* wallets.send(alice, new Open({ balance: 100 }));
      yield* wallets.send(bob, new Open({ balance: 0 }));
      const input = { from: "alice", to: "bob", amount: 40, approval: false };
      const first = yield* transfers.start("t-9", input);
      const second = yield* transfers.start("t-9", input);
      expect(second.executionId).toBe(first.executionId);
      expect(yield* first.result).toEqual({ approvedBy: null });
      expect((yield* wallets.state(alice)).balance).toBe(60);
    }).pipe(Effect.provide(Bank.layer(Handlers).pipe(Layer.provide(InMemory)))),
  );
});
