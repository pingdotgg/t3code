import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Account, Deposit, Deposited, Deposits } from "../catch-up/ledger.ts";
export { hosted } from "../catch-up/worker.ts";

/** How many deposits an account has had, and their total: one key per account, any history. */
export class Summary extends Domain.View("Summary", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ count: Schema.Number, total: Schema.Number }),
  initial: { count: 0, total: 0 },
  evolve: {
    Deposited: (s, e: Deposited) => ({ count: s.count + 1, total: s.total + e.amount }),
  },
}) {}

/** Every deposit across the bank: one key that every account feeds. */
export class BankTotal extends Domain.View("BankTotal", {
  from: [Account],
  key: Schema.String,
  keyOf: { Deposited: () => "bank" },
  state: Schema.Struct({ count: Schema.Number, total: Schema.Number }),
  initial: { count: 0, total: 0 },
  evolve: {
    Deposited: (s, e: Deposited) => ({ count: s.count + 1, total: s.total + e.amount }),
  },
}) {}

/** The benchmark's first deploy: accounts only. */
export class Before extends Domain.Model("Ledger", { aggregates: [Account] }) {}

/** The second deploy adds one view, keyed by account: one consumer key per instance. */
export class After extends Domain.Model("Ledger", { aggregates: [Account], views: [Deposits] }) {}

/** The view at version 1: keyed by account, so rebuilt in place. */
export class DepositsV1 extends Domain.View("Deposits", { ...Deposits.definition, version: 1 }) {}

/** The second deploy with the view at version 1. */
export class AfterV1 extends Domain.Model("Ledger", {
  aggregates: [Account],
  views: [DepositsV1],
}) {}

/** The second deploy of a depth run: a summary per account. */
export class AfterSummary extends Domain.Model("Ledger", {
  aggregates: [Account],
  views: [Summary],
}) {}

/** The second deploy of a bank-wide run: one total that every account feeds. */
export class AfterTotal extends Domain.Model("Ledger", {
  aggregates: [Account],
  views: [BankTotal],
}) {}

/** The view a benchmark adds in its second deploy, if any. */
export type BenchView =
  | { readonly kind: "deposits"; readonly view: typeof Deposits | typeof DepositsV1 }
  | { readonly kind: "summary"; readonly view: typeof Summary }
  | { readonly kind: "total"; readonly view: typeof BankTotal };

/**
 * The benchmark Worker's routes: `POST /seed/<from>/<count>/<events>` writes
 * `events` deposits to each of accounts `b<from>` to `b<from + count - 1>`;
 * `POST /deposit/<account>/<from>/<count>` writes deposits `from` to
 * `from + count - 1` to one account; `GET /account/<account>`,
 * `GET /view/<key>`, `GET /history` and `GET /version`.
 */
export const benchWorker = (version: string, added?: BenchView) =>
  Effect.gen(function* () {
    const accounts = yield* Account;
    const deposits = added?.kind === "deposits" ? yield* added.view : undefined;
    const summary = added?.kind === "summary" ? yield* added.view : undefined;
    const total = added?.kind === "total" ? yield* added.view : undefined;
    // Idempotent: a retried seed request doesn't deposit twice.
    const deposit = (account: string, amount: number) =>
      accounts.send(account, new Deposit({ amount }), { commandId: `seed-${account}-${amount}` });
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname.split("/");
        if (path[1] === "version") return HttpServerResponse.text(version);
        if (path[1] === "view") {
          const key = path[2]!;
          const state: unknown = deposits
            ? Option.getOrNull(yield* deposits.query(Account.ref(key)))
            : summary
              ? Option.getOrNull(yield* summary.query(Account.ref(key)))
              : total
                ? Option.getOrNull(yield* total.query(key))
                : null;
          return yield* HttpServerResponse.json(state);
        }
        if (path[1] === "account") {
          return yield* HttpServerResponse.json(yield* accounts.state(path[2]!));
        }
        if (path[1] === "history") {
          const history = deposits
            ? yield* deposits.history
            : summary
              ? yield* summary.history
              : total
                ? yield* total.history
                : undefined;
          return yield* HttpServerResponse.json(history ?? null);
        }
        if (path[1] === "deposit") {
          const account = path[2]!;
          const [from, count] = path.slice(3, 5).map(Number) as [number, number];
          yield* Effect.forEach(
            Array.from({ length: count }, (_, n) => from + n),
            (amount) => deposit(account, amount),
            { discard: true },
          );
          return HttpServerResponse.text("ok");
        }
        if (path[1] !== "seed") return HttpServerResponse.text("Not Found", { status: 404 });
        const [from, count, events] = path.slice(2, 5).map(Number) as [number, number, number];
        yield* Effect.forEach(
          Array.from({ length: count }, (_, i) => `b${from + i}`),
          (account) =>
            Effect.forEach(
              Array.from({ length: events }, (_, n) => n + 1),
              (amount) => deposit(account, amount),
              { discard: true },
            ),
          { concurrency: 50, discard: true },
        );
        return HttpServerResponse.text("ok");
      }).pipe(
        Effect.catchTag("ConsistencyTimeout", () =>
          Effect.succeed(HttpServerResponse.text("not caught up", { status: 503 })),
        ),
      ),
    };
  });
