import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Account } from "../src/Account/Account.aggregate.ts";
import { mainAccountId } from "../src/Account/Account.id.ts";
import { AccountActivity } from "../src/Account/AccountActivity.view.ts";
import { AccountCard, CardChanged } from "../src/Account/AccountCard.stream.ts";
import { AccountSummary } from "../src/Account/AccountSummary.view.ts";
import { ChangeOwner, NotPermitted, OwnerChanged } from "../src/Account/ChangeOwner.command.ts";
import { AccountClosed, CloseAccount } from "../src/Account/CloseAccount.command.ts";
import { TransferCredited } from "../src/Account/CreditTransfer.command.ts";
import { TransferDebited } from "../src/Account/DebitTransfer.command.ts";
import { MoneyDeposited } from "../src/Account/DepositMoney.command.ts";
import { AccountFrozen, FreezeAccount } from "../src/Account/FreezeAccount.command.ts";
import { Frozen } from "../src/Account/Frozen.rejection.ts";
import { InsufficientFunds } from "../src/Account/InsufficientFunds.rejection.ts";
import { NotOwner } from "../src/Account/NotOwner.rejection.ts";
import { AccountOpened } from "../src/Account/OpenAccount.command.ts";
import {
  RecordSettlement,
  SettlementOnClosedAccount,
} from "../src/Account/RecordSettlement.command.ts";
import { TransferRefunded } from "../src/Account/RefundTransfer.command.ts";
import { Statement } from "../src/Account/Statement.view.ts";
import {
  DailyLimitExceeded,
  MoneyWithdrawn,
  WithdrawMoney,
} from "../src/Account/WithdrawMoney.command.ts";
import { type Actor, agent, customer, system } from "../src/Actor.ts";
import { Bank, BankHandlers } from "../src/Bank.model.ts";
import { CurrentActor } from "../src/CurrentActor.context.ts";
import { UsernameClaimed } from "../src/Customer/ClaimUsername.command.ts";
import { CustomerRegistered } from "../src/Customer/ConfirmRegistration.command.ts";
import { Customer } from "../src/Customer/Customer.aggregate.ts";
import { CustomerId } from "../src/Customer/Customer.id.ts";
import { CustomerDashboard } from "../src/Customer/CustomerDashboard.view.ts";
import {
  RegisterCustomer,
  RegistrationRequested,
} from "../src/Customer/RegisterCustomer.command.ts";
import { RegistrationRejected } from "../src/Customer/RejectRegistration.command.ts";
import { Username } from "../src/Customer/Username.ts";
import { UsernameClaim } from "../src/Customer/UsernameClaim.aggregate.ts";
import { DailyOutflow } from "../src/Fraud/DailyOutflow.view.ts";
import { FraudCheck } from "../src/Fraud/FraudCheck.external.ts";
import { MemoryLedgerStore, memoryLedger } from "../src/Ledger/LedgerStore.ts";
import { Payments } from "../src/Settlement/Payments.external.ts";
import { AccountTransfers } from "../src/Transfer/AccountTransfers.view.ts";
import {
  ApproveTransfer,
  NotAwaitingApproval,
  TransferApproved,
} from "../src/Transfer/ApproveTransfer.command.ts";
import { TransferCompleted } from "../src/Transfer/CompleteTransfer.command.ts";
import { TransferFailed } from "../src/Transfer/FailTransfer.command.ts";
import { RequestTransfer, TransferRequested } from "../src/Transfer/RequestTransfer.command.ts";
import { Transfer } from "../src/Transfer/Transfer.aggregate.ts";
import { TransferStatus } from "../src/Transfer/TransferStatus.view.ts";

const {
  call,
  clock,
  emitted,
  given,
  provide,
  rejected,
  replied,
  succeed,
  state,
  streamed,
  then,
  view,
  when,
} = Story;

/** Act as this actor for the following commands, as their session middleware would. */
const as = (actor: Actor) => provide(CurrentActor, actor);

const story = Story.make(Bank, {
  layer: BankHandlers.pipe(Layer.provide(MemoryLedgerStore)),
  stub: [FraudCheck, Payments],
});

const a1 = Account.ref("a-1");
const a2 = Account.ref("a-2");
const c1 = Customer.ref("c-1");
const c2 = Customer.ref("c-2");
const t1 = Transfer.ref("t-1");
const sam = customer("c-1");
const alex = customer("c-2");
const samsName = Username.make("sam");
const opened = (customerId = "c-1") =>
  new AccountOpened({ customerId: CustomerId.make(customerId), owner: "sam" });

it.effect("registering claims the username, then opens a main account", () =>
  story(
    as(sam),
    when(c1, new RegisterCustomer({ name: "sam", username: samsName })),
    then(
      c1,
      new RegistrationRequested({ name: "sam", username: samsName }),
      new CustomerRegistered({ name: "sam", username: samsName }),
    ),
    then(UsernameClaim.ref("sam"), new UsernameClaimed({ customerId: c1.id })),
    then(
      Account.ref(mainAccountId(CustomerId.make("c-1"))),
      new AccountOpened({ customerId: c1.id, owner: "sam" }),
    ),
    view(AccountSummary, Account.ref("c-1-main"), {
      customerId: c1.id,
      owner: "sam",
      balance: 0,
      frozen: false,
    }),
    view(CustomerDashboard, c1, (d) => expect(d.balances).toEqual({ ["c-1-main"]: 0 } as any)),
  ),
);

it.effect("a taken username rejects the registration, and nothing else happens", () =>
  story(
    given(UsernameClaim.ref("sam"), new UsernameClaimed({ customerId: c1.id })),
    as(alex),
    when(c2, new RegisterCustomer({ name: "alex", username: samsName })),
    then(
      c2,
      new RegistrationRequested({ name: "alex", username: samsName }),
      new RegistrationRejected({ username: samsName, reason: "username taken" }),
    ),
    then(Account.ref(mainAccountId(CustomerId.make("c-2")))),
    // The customer can try again with another name.
    when(c2, new RegisterCustomer({ name: "alex", username: Username.make("alex") })),
    then(
      c2,
      new RegistrationRequested({ name: "alex", username: Username.make("alex") }),
      new CustomerRegistered({ name: "alex", username: Username.make("alex") }),
    ),
    then(UsernameClaim.ref("alex"), new UsernameClaimed({ customerId: c2.id })),
    then(
      Account.ref(mainAccountId(CustomerId.make("c-2"))),
      new AccountOpened({ customerId: c2.id, owner: "alex" }),
    ),
  ),
);

it.effect("withdraw replies with the new balance and updates projections", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 30 })),
    then(a1, new MoneyWithdrawn({ amount: 30, balanceAfter: 70 })),
    replied({ balance: 70 }),
    view(AccountSummary, a1, { balance: 70 }),
    emitted(Statement, a1, [
      { kind: "deposit", amount: 100, balance: 100 },
      { kind: "withdrawal", amount: 30, balance: 70 },
    ]),
  ),
);

it.effect("overdraft is rejected with evidence", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 50, balanceAfter: 50 })),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 80 })),
    rejected(new InsufficientFunds({ balance: 50, requested: 80 })),
  ),
);

it.effect("a customer can't withdraw from someone else's account", () =>
  story(
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    as(alex),
    when(a1, new WithdrawMoney({ amount: 30 })),
    rejected(new NotOwner()),
  ),
);

it.effect("the daily limit uses the story clock", () =>
  story(
    clock("2026-10-09T09:00:00Z"),
    given(a1, opened(), new MoneyDeposited({ amount: 300_000, balanceAfter: 300_000 })),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 40_000 })),
    when(a1, new WithdrawMoney({ amount: 40_000 })),
    call(FraudCheck.score, { accountId: a1.id, amount: 80_000 }),
    succeed(FraudCheck.score, { risk: 0.1 }),
    when(a1, new WithdrawMoney({ amount: 30_000 })),
    rejected(new DailyLimitExceeded({ remaining: 20_000 })),
    clock("2026-10-10T00:00:01Z"),
    when(a1, new WithdrawMoney({ amount: 30_000 })),
    then(
      a1,
      new MoneyWithdrawn({ amount: 40_000, balanceAfter: 260_000 }),
      new MoneyWithdrawn({ amount: 40_000, balanceAfter: 220_000 }),
      new MoneyWithdrawn({ amount: 30_000, balanceAfter: 190_000 }),
    ),
  ),
);

it.effect("freezing twice records nothing", () =>
  story(
    given(a1, opened(), new AccountFrozen({ reason: "kyc", by: agent("support-7") })),
    as(agent("support-7")),
    when(a1, new FreezeAccount({ reason: "again" })),
    then(a1),
    state(a1, (s) => expect(s).toMatchObject({ frozen: "kyc" })),
  ),
);

it.effect(
  "a risky withdrawal freezes the account (an external system call suspends until answered)",
  () =>
    story(
      given(a1, opened(), new MoneyDeposited({ amount: 90_000, balanceAfter: 90_000 })),
      as(sam),
      when(a1, new WithdrawMoney({ amount: 60_000 })),
      then(a1, new MoneyWithdrawn({ amount: 60_000, balanceAfter: 30_000 })),
      call(FraudCheck.score, { accountId: a1.id, amount: 60_000 }),
      succeed(FraudCheck.score, { risk: 0.95 }),
      then(a1, new AccountFrozen({ reason: "fraud risk 0.95", by: system("FraudReview") })),
      when(a1, new WithdrawMoney({ amount: 10 })),
      rejected(new Frozen({ reason: "fraud risk 0.95" })),
    ),
);

it.effect(
  "split withdrawals that cross the daily threshold are reviewed (a policy on a view)",
  () =>
    story(
      given(a1, opened(), new MoneyDeposited({ amount: 90_000, balanceAfter: 90_000 })),
      as(sam),
      when(a1, new WithdrawMoney({ amount: 30_000 })),
      when(a1, new WithdrawMoney({ amount: 30_000 })),
      then(
        a1,
        new MoneyWithdrawn({ amount: 30_000, balanceAfter: 60_000 }),
        new MoneyWithdrawn({ amount: 30_000, balanceAfter: 30_000 }),
      ),
      emitted(DailyOutflow, a1, [{ day: "2026-01-01", total: 60_000 }]),
      call(FraudCheck.score, { accountId: a1.id, amount: 60_000 }),
      succeed(FraudCheck.score, { risk: 0.1 }),
      then(a1),
    ),
);

it.effect("race: the account is closed while the fraud check is pending", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 60_000, balanceAfter: 60_000 })),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 60_000 })),
    call(FraudCheck.score, { accountId: a1.id, amount: 60_000 }),
    when(a1, new CloseAccount()),
    then(a1, new MoneyWithdrawn({ amount: 60_000, balanceAfter: 0 }), new AccountClosed()),
    succeed(FraudCheck.score, { risk: 0.95 }),
    then(a1),
    view(AccountSummary, a1, { closed: true }),
  ),
);

it.effect("a transfer completes: the process manager drives both accounts", () =>
  story(
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    given(a2, opened("c-2")),
    as(sam),
    when(t1, new RequestTransfer({ from: a1.id, to: a2.id, amount: 40 })),
    then(
      t1,
      new TransferRequested({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 40,
        requestedBy: sam,
        needsApproval: false,
      }),
    ),
    then(a1, new TransferDebited({ transferId: t1.id, amount: 40, balanceAfter: 60 })),
    then(a2, new TransferCredited({ transferId: t1.id, amount: 40, balanceAfter: 40 })),
    then(t1, new TransferCompleted({ transferId: t1.id })),
    view(TransferStatus, t1, (v) => expect(TransferStatus.computed.status(v)).toBe("completed")),
    emitted(AccountTransfers, a1, [{ transferId: t1.id, amount: 40, direction: "out" }]),
    emitted(AccountTransfers, a2, [{ transferId: t1.id, amount: 40, direction: "in" }]),
  ),
);

it.effect("a customer can't move money out of someone else's account with a transfer", () =>
  story(
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    given(a2, opened("c-2")),
    as(alex),
    when(t1, new RequestTransfer({ from: a1.id, to: a2.id, amount: 40 })),
    then(
      t1,
      new TransferRequested({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 40,
        requestedBy: alex,
        needsApproval: false,
      }),
    ),
    then(a1),
    then(t1, new TransferFailed({ transferId: t1.id, reason: "not your account" })),
  ),
);

it.effect("a large transfer waits for a support agent's approval", () =>
  story(
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100_000, balanceAfter: 100_000 })),
    given(a2, opened("c-2")),
    as(sam),
    when(t1, new RequestTransfer({ from: a1.id, to: a2.id, amount: 20_000 })),
    then(
      t1,
      new TransferRequested({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 20_000,
        requestedBy: sam,
        needsApproval: true,
      }),
    ),
    then(a1),
    view(TransferStatus, t1, (v) =>
      expect(TransferStatus.computed.status(v)).toBe("awaiting-approval"),
    ),
    as(agent("support-7")),
    when(t1, new ApproveTransfer()),
    then(
      t1,
      new TransferApproved({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 20_000,
        requestedBy: sam,
        approvedBy: agent("support-7"),
      }),
      new TransferCompleted({ transferId: t1.id }),
    ),
    then(a1, new TransferDebited({ transferId: t1.id, amount: 20_000, balanceAfter: 80_000 })),
    then(a2, new TransferCredited({ transferId: t1.id, amount: 20_000, balanceAfter: 20_000 })),
  ),
);

it.effect("an unapproved transfer expires when its approval window closes", () =>
  story(
    clock("2026-01-01T09:00:00Z"),
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100_000, balanceAfter: 100_000 })),
    given(a2, opened("c-2")),
    as(sam),
    when(t1, new RequestTransfer({ from: a1.id, to: a2.id, amount: 20_000 })),
    then(
      t1,
      new TransferRequested({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 20_000,
        requestedBy: sam,
        needsApproval: true,
      }),
    ),
    clock("2026-01-02T08:59:00Z"),
    then(t1),
    clock("2026-01-02T09:00:00Z"),
    then(t1, new TransferFailed({ transferId: t1.id, reason: "not approved in time" })),
    // Approval and expiry race on the Transfer; expiry won, so approval is too late.
    as(agent("support-7")),
    when(t1, new ApproveTransfer()),
    rejected(new NotAwaitingApproval()),
    then(a1),
  ),
);

it.effect("a transfer to a closed account is compensated", () =>
  story(
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    given(a2, opened("c-2"), new AccountClosed()),
    as(sam),
    when(t1, new RequestTransfer({ from: a1.id, to: a2.id, amount: 40 })),
    then(
      t1,
      new TransferRequested({
        transferId: t1.id,
        from: a1.id,
        to: a2.id,
        amount: 40,
        requestedBy: sam,
        needsApproval: false,
      }),
    ),
    then(
      a1,
      new TransferDebited({ transferId: t1.id, amount: 40, balanceAfter: 60 }),
      new TransferRefunded({ transferId: t1.id, amount: 40, balanceAfter: 100 }),
    ),
    then(t1, new TransferFailed({ transferId: t1.id, reason: "destination account not open" })),
    view(TransferStatus, t1, { amount: 40, debited: true, credited: false, refunded: true }),
  ),
);

it.effect("a settlement on a closed account can't be rejected, so it is refunded", () =>
  story(
    given(a1, opened(), new AccountClosed()),
    when(a1, new RecordSettlement({ settlementId: "st_1", amount: 500 })),
    then(a1, new SettlementOnClosedAccount({ settlementId: "st_1", amount: 500 })),
    call(Payments.refund, { settlementId: "st_1", amount: 500 }),
    succeed(Payments.refund, { refundId: "re_1" }),
    emitted(AccountActivity, a1, (entries) =>
      expect(entries.at(-1)?.event._tag).toBe("SettlementOnClosedAccount"),
    ),
  ),
);

it.effect("only agents reassign accounts, and the dashboards re-key", () =>
  story(
    given(c1, new CustomerRegistered({ name: "sam", username: samsName })),
    given(c2, new CustomerRegistered({ name: "alex", username: Username.make("alex") })),
    given(a1, opened("c-1"), new MoneyDeposited({ amount: 100, balanceAfter: 100 })),
    view(CustomerDashboard, c1, (d) => expect(d.balances).toEqual({ ["a-1"]: 100 } as any)),
    as(sam),
    when(a1, new ChangeOwner({ customerId: c2.id })),
    rejected(new NotPermitted()),
    as(agent("support-7")),
    when(a1, new ChangeOwner({ customerId: c2.id })),
    then(a1, new OwnerChanged({ previous: c1.id, customerId: c2.id, by: agent("support-7") })),
    view(CustomerDashboard, c1, (d) => expect(d.balances).toEqual({} as any)),
    view(CustomerDashboard, c2, (d) =>
      expect(CustomerDashboard.computed.totalBalance(d)).toBe(100),
    ),
  ),
);

it.effect("an unasserted rejection fails the story", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 1, balanceAfter: 1 })),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 5 })),
  ).pipe(
    Effect.flip,
    Effect.map((failure) => expect(failure.message).toMatch(/InsufficientFunds/)),
  ),
);

it.effect("an unanswered external system call fails the story", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 90_000, balanceAfter: 90_000 })),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 60_000 })),
  ).pipe(
    Effect.flip,
    Effect.map((failure) => expect(failure.message).toMatch(/unanswered external system calls/)),
  ),
);

// ---------------------------------------------------------------- projections

/** A story whose projections write a ledger the test can read. */
const ledgerStory = Story.make(Bank, {
  layer: BankHandlers,
  stub: [FraudCheck, Payments],
});

it.effect("the Ledger projection records each movement in a store outside the model", () =>
  Effect.gen(function* () {
    const ledger = memoryLedger();
    yield* ledgerStory(
      given(a1, opened(), new MoneyDeposited({ amount: 10_000, balanceAfter: 10_000 })),
      as(sam),
      when(a1, new WithdrawMoney({ amount: 2_500 })),
      then(a1, new MoneyWithdrawn({ amount: 2_500, balanceAfter: 7_500 })),
    ).pipe(Effect.provide(ledger.layer));
    const rows = yield* ledger.forAccount("a-1");
    expect(rows.map((row) => [row.kind, row.amount, row.balanceAfter])).toEqual([
      ["MoneyDeposited", 10_000, 10_000],
      ["MoneyWithdrawn", 2_500, 7_500],
    ]);
  }),
);

it.effect("the AccountCards projection appends a card on every balance change", () =>
  story(
    given(a1, opened(), new MoneyDeposited({ amount: 10_000, balanceAfter: 10_000 })),
    streamed(
      AccountCard,
      a1,
      new CardChanged({ customerId: c1.id, owner: "sam", balance: 10_000, frozen: false }),
    ),
    as(sam),
    when(a1, new WithdrawMoney({ amount: 2_500 })),
    then(a1, new MoneyWithdrawn({ amount: 2_500, balanceAfter: 7_500 })),
    streamed(
      AccountCard,
      a1,
      new CardChanged({ customerId: c1.id, owner: "sam", balance: 7_500, frozen: false }),
    ),
  ),
);
