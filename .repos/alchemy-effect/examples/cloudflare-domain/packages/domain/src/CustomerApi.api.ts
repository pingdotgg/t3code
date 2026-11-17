import * as Domain from "@alchemy.run/domain";
import { Bank } from "./Bank.model.ts";

/**
 * What the customer app reaches: commands to change things, and the Account
 * aggregate and views to read and watch. Each entry authorizes itself,
 * through its `decide` or `validate`.
 */
export class CustomerApi extends Domain.Api("CustomerApi", {
  model: Bank,
  commands: [
    "RegisterCustomer",
    "DepositMoney",
    "WithdrawMoney",
    "CloseAccount",
    "RequestTransfer",
  ],
  views: ["CustomerDashboard", "AccountSummary", "Statement", "AccountTransfers", "TransferStatus"],
  streams: ["AccountCard"],
  aggregates: ["Account"],
}) {}
