import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
export class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
}) {}
export class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit],
  decide: { Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })] },
  evolve: { Deposited: (s, e) => ({ balance: s.balance + e.amount }) },
}) {}

/** Every deposit to an account, in the order the view applied them: added in the second deploy. */
export class Deposits extends Domain.View("Deposits", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ amounts: Schema.Array(Schema.Number) }),
  initial: { amounts: [] },
  evolve: { Deposited: (s, e) => ({ amounts: [...s.amounts, e.amount] }) },
}) {}

/** Every deposit across every account, in the order the view applied them: one hot key. */
export class Timeline extends Domain.View("Timeline", {
  from: [Account],
  key: Schema.String,
  keyOf: { Deposited: () => "all" },
  state: Schema.Struct({ entries: Schema.Array(Schema.String) }),
  initial: { entries: [] },
  evolve: {
    Deposited: (s, e, { source }) => ({ entries: [...s.entries, `${source.id}:${e.amount}`] }),
  },
}) {}

/** The first deploy: accounts only. */
export class Before extends Domain.Model("Ledger", { aggregates: [Account] }) {}

/** The second deploy adds the view; its history must reach it. */
export class After extends Domain.Model("Ledger", {
  aggregates: [Account],
  views: [Deposits, Timeline],
}) {}

/** The view redefined: it now records each deposit doubled, at version 1. */
export class DoubledDeposits extends Domain.View("Deposits", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ amounts: Schema.Array(Schema.Number) }),
  initial: { amounts: [] },
  evolve: { Deposited: (s, e) => ({ amounts: [...s.amounts, e.amount * 2] }) },
  version: 1,
}) {}

/** The third deploy: the redefined view, at version 1. */
export class Rebuilt extends Domain.Model("Ledger", {
  aggregates: [Account],
  views: [DoubledDeposits, Timeline],
}) {}

export class Noted extends Domain.Event("Noted", { note: Schema.String }) {}
export class Note extends Domain.Command("Note", {
  target: Schema.String,
  input: { note: Schema.String },
  events: [Noted],
}) {}
/** A second aggregate, for a view that comes to read it too. */
export class Journal extends Domain.Aggregate("Journal", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Note],
  decide: { Note: (_, cmd) => [new Noted({ note: cmd.note })] },
  evolve: { Noted: (s) => s },
}) {}

/** The timeline, now reading the journal too: the same view, at the same version unless bumped. */
export class WideTimeline extends Domain.View("Timeline", {
  from: [Account, Journal],
  key: Schema.String,
  keyOf: { Deposited: () => "all", Noted: () => "all" },
  state: Schema.Struct({ entries: Schema.Array(Schema.String) }),
  initial: { entries: [] },
  evolve: {
    Deposited: (s, e, { source }) => ({ entries: [...s.entries, `${source.id}:${e.amount}`] }),
    Noted: (s, e) => ({ entries: [...s.entries, `note:${e.note}`] }),
  },
}) {}

/** A deploy whose timeline reads the journal too. */
export class Widened extends Domain.Model("Ledger", {
  aggregates: [Account, Journal],
  views: [Deposits, WideTimeline],
}) {}

/** The wider timeline at version 1: rebuilt from every source's history. */
export class WideTimelineV1 extends Domain.View("Timeline", {
  ...WideTimeline.definition,
  version: 1,
}) {}

/** A deploy whose timeline reads the journal too, at version 1. */
export class WidenedV1 extends Domain.Model("Ledger", {
  aggregates: [Account, Journal],
  views: [Deposits, WideTimelineV1],
}) {}
