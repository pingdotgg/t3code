import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
export class Withdrawn extends Domain.Event("Withdrawn", { amount: Schema.Number }) {}
export class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
}) {}
export class Withdraw extends Domain.Command("Withdraw", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Withdrawn],
}) {}
export class Account extends Domain.Aggregate("Account", {
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

/** One row per account, counting deposits only. */
export class Summary extends Domain.View("Summary", {
  from: [Account],
  key: Account,
  state: Net,
  initial: { net: 0 },
  evolve: { Deposited: (s, e) => ({ net: s.net + e.amount }) },
}) {}

/** Fixed to count withdrawals, an event its rows never received: version 1. */
export class SummaryV1 extends Domain.View("Summary", {
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

/** Each account's latest net, built on the summary. */
export class Latest extends Domain.View("Latest", {
  from: [Summary],
  key: Account,
  state: Net,
  initial: { net: 0 },
  evolve: { Deposited: (_, __, { state }) => ({ net: state?.net ?? 0 }) },
}) {}
export class LatestOfV1 extends Domain.View("Latest", {
  from: [SummaryV1],
  key: Account,
  state: Net,
  initial: { net: 0 },
  evolve: {
    Deposited: (_, __, { state }) => ({ net: state?.net ?? 0 }),
    Withdrawn: (_, __, { state }) => ({ net: state?.net ?? 0 }),
  },
}) {}

export class Bank extends Domain.Model("Bank", {
  aggregates: [Account],
  views: [Summary, Latest],
}) {}
export class BankV1 extends Domain.Model("Bank", {
  aggregates: [Account],
  views: [SummaryV1, LatestOfV1],
}) {}
