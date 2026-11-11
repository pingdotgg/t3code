import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";

// One aggregate and one view definition, used by two independent models.
export class Opened extends Domain.Event("Opened", { owner: Schema.String }) {}
export class Open extends Domain.Command("Open", {
  target: Schema.String,
  input: { owner: Schema.String },
  events: [Opened],
}) {}
export class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ owner: Schema.NullOr(Schema.String) }),
  initial: { owner: null },
  commands: [Open],
  decide: { Open: (_, { owner }) => [new Opened({ owner })] },
  evolve: { Opened: (_, { owner }) => ({ owner }) },
}) {}
export class Owners extends Domain.View("Owners", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ owner: Schema.String }),
  initial: { owner: "" },
  evolve: { Opened: (_, { owner }) => ({ owner }) },
}) {}

export class Billing extends Domain.Model("Billing", { aggregates: [Account], views: [Owners] }) {}
export class Audit extends Domain.Model("Audit", { aggregates: [Account], views: [Owners] }) {}

// One saga definition, run by two independent models.
export class OpenAccount extends Domain.Saga("OpenAccount", {
  key: Schema.String,
  input: { owner: Schema.String },
}) {}
export const OpenAccountLive = OpenAccount.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;
    return Effect.fn(function* ({ key, owner }) {
      yield* Activity.make({
        name: "open",
        execute: accounts.send(key, new Open({ owner })).pipe(Effect.asVoid),
      });
    });
  }),
);
export class Sales extends Domain.Model("Sales", { aggregates: [Account], sagas: [OpenAccount] }) {}
export class Support extends Domain.Model("Support", {
  aggregates: [Account],
  sagas: [OpenAccount],
}) {}
