import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { Activity } from "effect/workflow";

// A wallet whose debits a policy audits on a second aggregate, and reminds later.
class Opened extends Domain.Event("Opened", { balance: Schema.Number }) {}
class Debited extends Domain.Event(
  "Debited",
  { amount: Schema.Number, note: Schema.Redacted(Schema.String) },
  { attributes: (e) => ({ "wallet.amount": e.amount, "wallet.note": e.note }) },
) {}
class Insufficient extends Domain.Rejection(
  "Insufficient",
  { balance: Schema.Number },
  { attributes: (r) => ({ "wallet.balance": r.balance }) },
) {}

class Open extends Domain.Command("Open", {
  target: Schema.String,
  input: { balance: Schema.Number },
  events: [Opened],
}) {}
class Debit extends Domain.Command("Debit", {
  target: Schema.String,
  input: { amount: Schema.Number, note: Schema.Redacted(Schema.String) },
  events: [Debited],
  rejects: [Insufficient],
  attributes: (cmd) => ({ "wallet.amount": cmd.amount }),
}) {}

class Wallet extends Domain.Aggregate("Wallet", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Open, Debit],
  decide: {
    Open: (_, cmd) => [new Opened({ balance: cmd.balance })],
    Debit: Effect.fn(function* (s, cmd) {
      yield* Effect.annotateCurrentSpan("wallet.checked", true);
      return s.balance < cmd.amount
        ? yield* new Insufficient({ balance: s.balance })
        : [new Debited({ amount: cmd.amount, note: cmd.note })];
    }),
  },
  evolve: {
    Opened: (_, e) => ({ balance: e.balance }),
    Debited: (s, e) => ({ balance: s.balance - e.amount }),
  },
}) {}

class Audited extends Domain.Event("Audited", { wallet: Schema.String }) {}
class Reminded extends Domain.Event("Reminded") {}
class Audit extends Domain.Command("Audit", {
  target: Schema.String,
  input: { wallet: Schema.String },
  events: [Audited],
}) {}
class Remind extends Domain.Command("Remind", { target: Schema.String, events: [Reminded] }) {}
class Ledger extends Domain.Aggregate("Ledger", {
  id: Schema.String,
  state: Schema.Struct({ audits: Schema.Number }),
  initial: { audits: 0 },
  commands: [Audit, Remind],
  decide: {
    Audit: (_, cmd) => [new Audited({ wallet: cmd.wallet })],
    Remind: () => [new Reminded()],
  },
  evolve: {
    Audited: (s) => ({ audits: s.audits + 1 }),
    Reminded: (s) => s,
  },
}) {}

class AuditDebits extends Domain.Policy("AuditDebits", { from: Wallet, on: [Debited] }) {}
const AuditDebitsLive = AuditDebits.toLayer(
  Effect.gen(function* () {
    const ledgers = yield* Ledger;
    return Effect.fn(function* ({ source }) {
      yield* ledgers.send("main", new Audit({ wallet: source.id }));
      yield* ledgers
        .schedule("main", new Remind(), { after: "1 hour" })
        .pipe(Effect.catchTag("AlreadyExecuted", () => Effect.void));
    });
  }),
);

class Balance extends Domain.View("Balance", {
  from: [Wallet],
  key: Wallet,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  evolve: {
    Opened: (_, e) => ({ balance: e.balance }),
    Debited: (v, e) => ({ balance: v.balance - e.amount }),
  },
}) {}

// The model a browser client reads the balance from.
class Balances extends Domain.Model("TelemetryBalances", {
  aggregates: [Wallet],
  views: [Balance],
}) {}
class WalletApi extends Domain.Api("WalletApi", { model: Balances, views: ["Balance"] }) {}

class Bank extends Domain.Model("TelemetryBank", {
  aggregates: [Wallet, Ledger],
  policies: [AuditDebits],
}) {}

// A second model: a policy that checks an external system and starts a saga,
// and a projection over the wallet's events.
class Scorer extends Domain.ExternalSystem("Scorer", {
  score: { args: { wallet: Schema.String }, success: { risk: Schema.Number } },
}) {}

class Review extends Domain.Saga("Review", { key: Schema.String, input: {} }) {}
const ReviewLive = Review.toLayer(
  Effect.gen(function* () {
    const ledgers = yield* Ledger;
    return Effect.fn(function* ({ key }) {
      yield* Activity.make({
        name: "audit",
        execute: ledgers.send("main", new Audit({ wallet: key })).pipe(Effect.orDie),
      });
    });
  }),
);

class ReviewDebits extends Domain.Policy("ReviewDebits", { from: Wallet, on: [Debited] }) {}
const ReviewDebitsLive = ReviewDebits.toLayer(
  Effect.gen(function* () {
    const scorer = yield* Scorer;
    const reviews = yield* Review;
    return Effect.fn(function* ({ source }) {
      const { risk } = yield* scorer.score({ wallet: source.id });
      if (risk > 0.5) yield* reviews.start(source, {});
    });
  }),
);

class Movements extends Domain.Projection("Movements", {
  from: [Wallet],
  key: Wallet,
  on: [Debited],
}) {}
const MovementsLive = Movements.toLayer(Effect.succeed(() => Effect.void));

class Reviewed extends Domain.Model("TelemetryReviews", {
  aggregates: [Wallet, Ledger],
  policies: [ReviewDebits],
  projections: [Movements],
  sagas: [Review],
}) {}

const reviewStory = Story.make(Reviewed, {
  layer: Layer.mergeAll(ReviewDebitsLive, ReviewLive, MovementsLive),
  stub: [Scorer],
});

const story = Story.make(Bank, { layer: Layer.mergeAll(AuditDebitsLive) });
const alice = Wallet.ref("alice");
const ledger = Ledger.ref("main");

/** A tracer that keeps every span it starts. */
const recording = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const named = (name: string) => spans.filter((span) => span.name === name);
  const one = (name: string) => {
    const found = named(name);
    expect(found.map((s) => s.name)).toEqual([name]);
    return found[0]!;
  };
  return { spans, tracer, named, one };
};

const parentId = (span: Tracer.Span) => Option.getOrUndefined(span.parent)?.spanId;

describe("Domain telemetry", { tags: ["unit", "local"] }, () => {
  it.effect("a command's whole flow is one trace, with one correlation id", () =>
    Effect.gen(function* () {
      const { tracer, one, spans } = recording();
      yield* story(
        Story.given(alice, new Opened({ balance: 100 })),
        Story.when(alice, new Debit({ amount: 40, note: Redacted.make("rent") })),
        Story.then(alice, new Debited({ amount: 40, note: Redacted.make("rent") })),
        Story.then(ledger, new Audited({ wallet: "alice" })),
      ).pipe(Effect.withTracer(tracer));

      const debit = one("Domain.decide Wallet.Debit");
      const policy = one("Domain.policy AuditDebits");
      const audit = one("Domain.decide Ledger.Audit");
      const auditSend = one("Domain.send Ledger.Audit");

      // The policy continues the debit's trace, and the command it sends continues the policy's.
      expect(policy.traceId).toBe(debit.traceId);
      expect(parentId(policy)).toBe(debit.spanId);
      expect(parentId(auditSend)).toBe(policy.spanId);
      expect(parentId(audit)).toBe(auditSend.spanId);
      expect(audit.traceId).toBe(debit.traceId);

      // One correlation id, the debit's command id, end to end.
      const correlation = debit.attributes.get("domain.correlation_id");
      expect(correlation).toBe(debit.attributes.get("domain.command_id"));
      for (const span of [policy, auditSend, audit]) {
        expect(span.attributes.get("domain.correlation_id")).toBe(correlation);
      }
      expect(spans.every((s) => s.status._tag === "Ended")).toBe(true);
    }),
  );

  it.effect("records only the attributes a declaration returns, and never a Redacted value", () =>
    Effect.gen(function* () {
      const { tracer, one } = recording();
      yield* story(
        Story.given(alice, new Opened({ balance: 100 })),
        Story.when(alice, new Debit({ amount: 40, note: Redacted.make("rent") })),
        Story.then(alice, new Debited({ amount: 40, note: Redacted.make("rent") })),
        Story.then(ledger, new Audited({ wallet: "alice" })),
      ).pipe(Effect.withTracer(tracer));

      const debit = one("Domain.decide Wallet.Debit");
      expect(debit.attributes.get("wallet.amount")).toBe(40);
      expect(debit.attributes.get("wallet.checked")).toBe(true); // annotated inside decide
      expect(debit.attributes.get("domain.outcome")).toBe("accepted");
      // The event's own attributes ride on its span event; its note is Redacted.
      const [name, , attributes] = debit.events[0]!;
      expect(name).toBe("Debited");
      expect(attributes).toMatchObject({ "wallet.amount": 40, "wallet.note": "<redacted>" });

      // Nothing from a payload is recorded unless a declaration asks for it.
      const audit = one("Domain.decide Ledger.Audit");
      const keys = [...audit.attributes.keys()];
      expect(keys.every((key) => key.startsWith("domain."))).toBe(true);
      const values = [
        ...debit.attributes.values(),
        ...debit.events.flatMap(([, , a]) => Object.values(a)),
      ];
      expect(values).not.toContain("rent");
    }),
  );

  it.effect("a rejection is an outcome, not an error", () =>
    Effect.gen(function* () {
      const { tracer, one } = recording();
      yield* story(
        Story.given(alice, new Opened({ balance: 10 })),
        Story.when(alice, new Debit({ amount: 40, note: Redacted.make("rent") })),
        Story.rejected(new Insufficient({ balance: 10 })),
      ).pipe(Effect.withTracer(tracer));

      const debit = one("Domain.decide Wallet.Debit");
      expect(debit.attributes.get("domain.outcome")).toBe("Insufficient");
      expect(debit.attributes.get("wallet.balance")).toBe(10);
      expect(debit.status._tag === "Ended" && debit.status.exit._tag).toBe("Success");
      const send = one("Domain.send Wallet.Debit");
      expect(send.attributes.get("domain.outcome")).toBe("Insufficient");
      expect(send.status._tag === "Ended" && send.status.exit._tag).toBe("Success");
    }),
  );

  it.effect("a scheduled command links to its cause instead of continuing its trace", () =>
    Effect.gen(function* () {
      const { tracer, one } = recording();
      yield* story(
        Story.clock("2026-01-01T00:00:00Z"),
        Story.given(alice, new Opened({ balance: 100 })),
        Story.when(alice, new Debit({ amount: 40, note: Redacted.make("rent") })),
        Story.then(alice, new Debited({ amount: 40, note: Redacted.make("rent") })),
        Story.then(ledger, new Audited({ wallet: "alice" })),
        Story.clock("2026-01-01T01:00:00Z"),
        Story.then(ledger, new Reminded()),
      ).pipe(Effect.withTracer(tracer));

      const scheduled = one("Domain.schedule Ledger.Remind");
      const remind = one("Domain.decide Ledger.Remind");
      expect(parentId(remind)).not.toBe(scheduled.spanId);
      expect(remind.links.map((l) => l.span.spanId)).toEqual([scheduled.spanId]);
      // Still the same flow.
      expect(remind.attributes.get("domain.correlation_id")).toBe(
        one("Domain.decide Wallet.Debit").attributes.get("domain.correlation_id"),
      );
    }),
  );

  it.effect("a saga run starts its own trace, linked to the policy that started it", () =>
    Effect.gen(function* () {
      const { tracer, one, named } = recording();
      yield* reviewStory(
        Story.given(alice, new Opened({ balance: 100 })),
        Story.when(alice, new Debit({ amount: 40, note: Redacted.make("rent") })),
        Story.then(alice, new Debited({ amount: 40, note: Redacted.make("rent") })),
        Story.call(Scorer.score, { wallet: "alice" }),
        Story.succeed(Scorer.score, { risk: 0.9 }),
        Story.then(ledger, new Audited({ wallet: "alice" })),
        Story.saga(Review, "alice", { _tag: "Completed", result: undefined }),
      ).pipe(Effect.withTracer(tracer));

      const debit = one("Domain.decide Wallet.Debit");
      const policy = one("Domain.policy ReviewDebits");
      // The external call is part of the policy's run.
      expect(parentId(one("Domain.external Scorer.score"))).toBe(policy.spanId);

      // Every replay of the run is its own trace, linked to the policy that started it.
      const runs = named("Domain.saga Review");
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        expect(run.traceId).not.toBe(debit.traceId);
        expect(run.links.map((l) => l.span.spanId)).toEqual([policy.spanId]);
        expect(run.attributes.get("domain.correlation_id")).toBe(
          debit.attributes.get("domain.correlation_id"),
        );
      }
      // The command its step sends keeps the flow's correlation id.
      expect(one("Domain.decide Ledger.Audit").attributes.get("domain.correlation_id")).toBe(
        debit.attributes.get("domain.correlation_id"),
      );
    }),
  );

  it.effect("a projection batch links to the commits it handles", () =>
    Effect.gen(function* () {
      const { tracer, one } = recording();
      yield* reviewStory(
        Story.given(alice, new Opened({ balance: 100 })),
        Story.when(alice, new Debit({ amount: 40, note: Redacted.make("rent") })),
        Story.then(alice, new Debited({ amount: 40, note: Redacted.make("rent") })),
        Story.call(Scorer.score, { wallet: "alice" }),
        Story.succeed(Scorer.score, { risk: 0.1 }),
      ).pipe(Effect.withTracer(tracer));

      const debit = one("Domain.decide Wallet.Debit");
      const batch = one("Domain.projection Movements");
      expect(batch.traceId).not.toBe(debit.traceId);
      expect(batch.links.map((l) => l.span.spanId)).toEqual([debit.spanId]);
      expect(batch.attributes.get("domain.batch")).toBe(1);
    }),
  );

  it.effect("a live read carries the caller's span, so the server joins its trace", () =>
    Effect.gen(function* () {
      const { tracer } = recording();
      const urls: Array<string> = [];
      // A socket that never opens: enough to see what the client asked for.
      const sockets = Layer.succeed(Socket.WebSocketConstructor, (url) => {
        urls.push(url);
        return {
          addEventListener: () => {},
          removeEventListener: () => {},
          close: () => {},
          readyState: 0,
        } as never;
      });
      const watched = yield* Effect.gen(function* () {
        const client = yield* WalletApi.client;
        const fiber = yield* client.Balance.watch("alice").pipe(Stream.runDrain, Effect.forkChild);
        for (let i = 0; i < 100 && urls.length === 0; i++) yield* Effect.yieldNow;
        const span = yield* Effect.currentSpan;
        yield* Fiber.interrupt(fiber);
        return span;
      }).pipe(
        Effect.withSpan("click"),
        Effect.scoped,
        Effect.provide(
          Domain.protocolWebSocket("http://bank.test/api").pipe(
            Layer.provide(Layer.mergeAll(FetchHttpClient.layer, sockets)),
          ),
        ),
        Effect.withTracer(tracer),
      );
      expect(urls).toHaveLength(1);
      const read = JSON.parse(new URL(urls[0]!).searchParams.get("read")!);
      expect(read.tag).toBe("Balance.watch");
      // The RPC client's span for the read, a child of the caller's.
      expect(read.traceId).toBe(watched.traceId);
      expect(typeof read.spanId).toBe("string");
    }),
  );

  it.effect("counts commands by outcome", () =>
    Effect.gen(function* () {
      const rejected = Metric.withAttributes(Domain.Telemetry.commands, {
        "domain.aggregate": "Wallet",
        "domain.command": "Debit",
        "domain.outcome": "Insufficient",
      });
      const before = (yield* Metric.value(rejected)).count;
      yield* story(
        Story.given(alice, new Opened({ balance: 10 })),
        Story.when(alice, new Debit({ amount: 40, note: Redacted.make("rent") })),
        Story.rejected(new Insufficient({ balance: 10 })),
      );
      expect((yield* Metric.value(rejected)).count).toBe(before + 1);
    }),
  );
});
