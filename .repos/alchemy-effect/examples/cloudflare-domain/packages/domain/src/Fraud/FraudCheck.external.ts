import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { AccountId } from "../Account/Account.id.ts";
import { Cents } from "../Money.ts";

/** The external fraud-scoring system. */
export class FraudCheck extends Domain.ExternalSystem("FraudCheck", {
  score: { args: { accountId: AccountId, amount: Cents }, success: { risk: Schema.Number } },
}) {}
