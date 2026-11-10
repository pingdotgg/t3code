import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AccountId } from "../Account/Account.id.ts";
import { AccountSummary } from "../Account/AccountSummary.view.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { Forbidden } from "../Forbidden.rejection.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { Customer } from "./Customer.aggregate.ts";

type Balances = Readonly<Record<AccountId, number>>;

const without = (balances: Balances, id: AccountId): Balances => {
  const { [id]: _removed, ...rest } = balances;
  return rest;
};

/**
 * A customer's accounts and balances, built from AccountSummary's events and
 * the summary after each. An ownership change moves the account between
 * dashboards.
 */
export class CustomerDashboard extends Domain.View("CustomerDashboard", {
  from: [Customer, AccountSummary],
  key: Customer,
  middleware: [Session],
  rejects: [Forbidden],
  keyOf: {
    AccountSummary: ({ state }) => (state?.customerId ? Customer.ref(state.customerId) : undefined),
    OwnerChanged: {
      previous: ({ event }) => Customer.ref(event.previous),
      current: ({ event }) => Customer.ref(event.customerId),
    },
  },
  state: Schema.Struct({
    name: Schema.NullOr(Schema.String),
    balances: Schema.Record(AccountId, Cents),
  }),
  initial: { name: null, balances: {} },
  evolve: {
    CustomerRegistered: (d, e) => ({ ...d, name: e.name }),
    OwnerChanged: {
      previous: (d, _, { source }) => ({ ...d, balances: without(d.balances, source.id) }),
      current: (d, _, { source, state }) => ({
        ...d,
        balances: { ...d.balances, [source.id]: state?.balance ?? 0 },
      }),
    },
    AccountSummary: (d, _, { source, state }) => ({
      ...d,
      balances:
        state && !state.closed
          ? { ...d.balances, [source.id]: state.balance }
          : without(d.balances, source.id),
    }),
  },
  // Keyed by customer, so the key alone decides who may read it.
  validate: Effect.fn(function* (request) {
    const actor = yield* CurrentActor;
    if (actor._tag === "Agent") return;
    if (actor._tag !== "Customer" || request.key.id !== actor.customerId) {
      return yield* new Forbidden({ reason: "that is not your dashboard" });
    }
  }),
  computed: {
    totalBalance: (d) => Object.values<number>(d.balances).reduce((a, b) => a + b, 0),
  },
}) {}
