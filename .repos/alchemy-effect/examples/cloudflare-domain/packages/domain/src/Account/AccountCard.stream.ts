import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CustomerId } from "../Customer/Customer.id.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { Account } from "./Account.aggregate.ts";
import { mustOwn } from "./mustOwn.ts";
import { NotOwner } from "./NotOwner.rejection.ts";

/** What an account's card shows, as of one change. */
export class CardChanged extends Domain.Event("CardChanged", {
  customerId: CustomerId,
  owner: Schema.String,
  balance: Cents,
  frozen: Schema.Boolean,
}) {}

/**
 * Every version of an account's card, in order. The latest entry is the card
 * now (`peek`, `watch`); the log is its history (`events`, `list`). Written by
 * the AccountCards projection.
 */
export class AccountCard extends Domain.Stream("AccountCard", {
  key: Account,
  entries: [CardChanged],
  middleware: [Session],
  rejects: [NotOwner],
  // Judged on the latest card: only its owner (or an agent) may read it.
  validate: Effect.fn(function* (_request, latest) {
    yield* mustOwn(latest?.event.customerId ?? null);
  }),
}) {}
