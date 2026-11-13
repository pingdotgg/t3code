import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import { Account } from "./Account/Account.aggregate.ts";
import { AccountActivity } from "./Account/AccountActivity.view.ts";
import { AccountCard } from "./Account/AccountCard.stream.ts";
import { AccountCards, AccountCardsLive } from "./Account/AccountCards.projection.ts";
import { AccountSummary } from "./Account/AccountSummary.view.ts";
import { Statement } from "./Account/Statement.view.ts";
import { Customer } from "./Customer/Customer.aggregate.ts";
import { CustomerDashboard } from "./Customer/CustomerDashboard.view.ts";
import {
  MainAccountProvisioning,
  MainAccountProvisioningLive,
} from "./Customer/MainAccountProvisioning.policy.ts";
import { UsernameClaim } from "./Customer/UsernameClaim.aggregate.ts";
import {
  UsernameReservation,
  UsernameReservationLive,
} from "./Customer/UsernameReservation.policy.ts";
import { DailyOutflow } from "./Fraud/DailyOutflow.view.ts";
import { FraudReview, FraudReviewLive } from "./Fraud/FraudReview.policy.ts";
import { Ledger, LedgerLive } from "./Ledger/Ledger.projection.ts";
import { SettlementRefund, SettlementRefundLive } from "./Settlement/SettlementRefund.policy.ts";
import { AccountTransfers } from "./Transfer/AccountTransfers.view.ts";
import { ExecuteTransfer, ExecuteTransferLive } from "./Transfer/ExecuteTransfer.saga.ts";
import { Transfer } from "./Transfer/Transfer.aggregate.ts";
import {
  TransferApprovalDeadline,
  TransferApprovalDeadlineLive,
} from "./Transfer/TransferApprovalDeadline.policy.ts";
import { TransferExecution, TransferExecutionLive } from "./Transfer/TransferExecution.policy.ts";
import { TransferStatus } from "./Transfer/TransferStatus.view.ts";

/** The bank: every aggregate, view, policy, projection, stream and saga, hosted together. */
export class Bank extends Domain.Model("Bank", {
  aggregates: [Customer, UsernameClaim, Account, Transfer],
  views: [
    AccountSummary,
    CustomerDashboard,
    Statement,
    AccountActivity,
    TransferStatus,
    AccountTransfers,
    DailyOutflow,
  ],
  policies: [
    UsernameReservation,
    MainAccountProvisioning,
    TransferExecution,
    TransferApprovalDeadline,
    FraudReview,
    SettlementRefund,
  ],
  projections: [Ledger, AccountCards],
  streams: [AccountCard],
  sagas: [ExecuteTransfer],
}) {}

/**
 * The policies' and projections' implementations. They require the FraudCheck
 * and Payments external systems, and the LedgerStore.
 */
export const BankHandlers = Layer.mergeAll(
  UsernameReservationLive,
  MainAccountProvisioningLive,
  TransferExecutionLive,
  ExecuteTransferLive,
  TransferApprovalDeadlineLive,
  FraudReviewLive,
  SettlementRefundLive,
  LedgerLive,
  AccountCardsLive,
);
