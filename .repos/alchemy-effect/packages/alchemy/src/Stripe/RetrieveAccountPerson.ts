import type {
  GetAccountPersonError,
  GetAccountPersonRequest,
  Person as StripePerson,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { AccountPerson } from "./AccountPerson.ts";

export interface RetrieveAccountPersonRequest extends Omit<
  GetAccountPersonRequest,
  "account" | "person"
> {}

/**
 * Retrieve a bound Stripe Account Person over HTTP.
 *
 * ### Reading a Person
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveAccountPerson(cfo);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveAccountPerson extends Binding.Service<
  RetrieveAccountPerson,
  "Stripe.RetrieveAccountPerson",
  (
    person: AccountPerson,
  ) => Effect.Effect<
    (
      request?: RetrieveAccountPersonRequest,
    ) => Effect.Effect<StripePerson, GetAccountPersonError, RuntimeContext>
  >
> {}

export const RetrieveAccountPerson = Binding.Service<RetrieveAccountPerson>(
  "Stripe.RetrieveAccountPerson",
);
