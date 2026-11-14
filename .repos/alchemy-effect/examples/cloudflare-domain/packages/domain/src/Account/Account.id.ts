import * as Schema from "effect/Schema";
import type { CustomerId } from "../Customer/Customer.id.ts";

export const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
export type AccountId = typeof AccountId.Type;

/** Every customer gets a main account with a predictable id. */
export const mainAccountId = (customerId: CustomerId): AccountId =>
  AccountId.make(`${customerId}-main`);
