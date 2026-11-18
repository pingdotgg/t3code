import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Optic from "effect/Optic";
import * as Schema from "effect/Schema";
import type { Actor } from "../Actor.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { CustomerId } from "../Customer/Customer.id.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { AccountId } from "./Account.id.ts";
import { ChangeOwner, NotPermitted, OwnerChanged } from "./ChangeOwner.command.ts";
import { AccountClosed, BalanceNotZero, CloseAccount } from "./CloseAccount.command.ts";
import { CreditTransfer, TransferCredited } from "./CreditTransfer.command.ts";
import { DebitTransfer, TransferDebited } from "./DebitTransfer.command.ts";
import { DepositMoney, MoneyDeposited } from "./DepositMoney.command.ts";
import { AccountFrozen, FreezeAccount } from "./FreezeAccount.command.ts";
import { Frozen } from "./Frozen.rejection.ts";
import { InsufficientFunds } from "./InsufficientFunds.rejection.ts";
import { mustOwn } from "./mustOwn.ts";
import { NotOpen } from "./NotOpen.rejection.ts";
import { NotOwner } from "./NotOwner.rejection.ts";
import { AccountOpened, AlreadyOpen, OpenAccount } from "./OpenAccount.command.ts";
import {
  RecordSettlement,
  SettlementOnClosedAccount,
  SettlementReceived,
} from "./RecordSettlement.command.ts";
import { RefundStranded, RefundTransfer, TransferRefunded } from "./RefundTransfer.command.ts";
import {
  DAILY_LIMIT,
  DailyLimitExceeded,
  MoneyWithdrawn,
  WithdrawMoney,
} from "./WithdrawMoney.command.ts";

const Open = Schema.TaggedStruct("Open", {
  customerId: CustomerId,
  owner: Schema.String,
  balance: Cents,
  frozen: Schema.NullOr(Schema.String),
  today: Schema.Struct({ day: Schema.String, withdrawn: Cents }),
});
type Open = typeof Open.Type;

const AccountState = Schema.Union([
  Schema.TaggedStruct("Unopened", {}),
  Open,
  Schema.TaggedStruct("Closed", {}),
]);
type AccountState = typeof AccountState.Type;

// Optics that focus on the Open account. decide refuses every command on an
// account that is not open, so these events only follow an Open state; on any
// other state an optic leaves it unchanged, which keeps evolve total.
const open = Optic.id<AccountState>().tag("Open");
const balance = open.key("balance");
const frozen = open.key("frozen");

// Authorization: customers may act on their own accounts; agents and the system on any.
const openFor = (s: AccountState, actor: Actor): Open | NotOpen | NotOwner =>
  s._tag !== "Open"
    ? new NotOpen()
    : actor._tag === "Customer" && actor.customerId !== s.customerId
      ? new NotOwner()
      : s;

// The open account, if the current actor (from the command's middleware) may act on it.
const authorized = Effect.fn(function* (s: AccountState) {
  const o = openFor(s, yield* CurrentActor);
  if (o._tag !== "Open") return yield* o;
  return o;
});

const dayOf = (t: DateTime.Utc) => DateTime.formatIsoDate(t);

/**
 * A bank account. Each command lives in its own file with the events it
 * records and the rejections only it returns; this file holds the state and
 * how commands and events change it. Commands sent by customers and agents
 * read the current actor from their middleware to authorize it.
 */
export class Account extends Domain.Aggregate("Account", {
  id: AccountId,
  state: AccountState,
  initial: { _tag: "Unopened" },
  commands: [
    OpenAccount,
    ChangeOwner,
    DepositMoney,
    WithdrawMoney,
    FreezeAccount,
    CloseAccount,
    DebitTransfer,
    CreditTransfer,
    RefundTransfer,
    RecordSettlement,
  ],
  decide: {
    OpenAccount: (s, cmd) =>
      s._tag !== "Unopened"
        ? new AlreadyOpen()
        : [new AccountOpened({ customerId: cmd.customerId, owner: cmd.owner })],

    ChangeOwner: Effect.fn(function* (s, cmd) {
      if (s._tag !== "Open") return yield* new NotOpen();
      const actor = yield* CurrentActor;
      if (actor._tag !== "Agent") return yield* new NotPermitted();
      return [new OwnerChanged({ previous: s.customerId, customerId: cmd.customerId, by: actor })];
    }),

    DepositMoney: Effect.fn(function* (s, cmd) {
      const o = yield* authorized(s);
      return [new MoneyDeposited({ amount: cmd.amount, balanceAfter: o.balance + cmd.amount })];
    }),

    WithdrawMoney: Effect.fn(function* (s, cmd, { now }) {
      const o = yield* authorized(s);
      if (o.frozen) return yield* new Frozen({ reason: o.frozen });
      if (cmd.amount > o.balance)
        return yield* new InsufficientFunds({ balance: o.balance, requested: cmd.amount });
      const used = o.today.day === dayOf(now) ? o.today.withdrawn : 0;
      if (used + cmd.amount > DAILY_LIMIT)
        return yield* new DailyLimitExceeded({ remaining: DAILY_LIMIT - used });
      return [new MoneyWithdrawn({ amount: cmd.amount, balanceAfter: o.balance - cmd.amount })];
    }),

    FreezeAccount: Effect.fn(function* (s, cmd) {
      const o = yield* authorized(s);
      const actor = yield* CurrentActor;
      return o.frozen ? [] : [new AccountFrozen({ reason: cmd.reason, by: actor })];
    }),

    CloseAccount: Effect.fn(function* (s) {
      const o = yield* authorized(s);
      if (o.balance !== 0) return yield* new BalanceNotZero({ balance: o.balance });
      return [new AccountClosed()];
    }),

    DebitTransfer: (s, cmd) => {
      const o = openFor(s, cmd.requestedBy);
      if (o._tag !== "Open") return o;
      if (o.frozen) return new Frozen({ reason: o.frozen });
      if (cmd.amount > o.balance)
        return new InsufficientFunds({ balance: o.balance, requested: cmd.amount });
      return [
        new TransferDebited({
          transferId: cmd.transferId,
          amount: cmd.amount,
          balanceAfter: o.balance - cmd.amount,
        }),
      ];
    },

    CreditTransfer: (s, cmd) =>
      s._tag !== "Open"
        ? new NotOpen()
        : [
            new TransferCredited({
              transferId: cmd.transferId,
              amount: cmd.amount,
              balanceAfter: s.balance + cmd.amount,
            }),
          ],

    RefundTransfer: (s, cmd) =>
      s._tag === "Open"
        ? [
            new TransferRefunded({
              transferId: cmd.transferId,
              amount: cmd.amount,
              balanceAfter: s.balance + cmd.amount,
            }),
          ]
        : [new RefundStranded({ transferId: cmd.transferId, amount: cmd.amount })],

    RecordSettlement: (s, cmd) =>
      s._tag === "Open"
        ? [
            new SettlementReceived({
              settlementId: cmd.settlementId,
              amount: cmd.amount,
              balanceAfter: s.balance + cmd.amount,
            }),
          ]
        : [new SettlementOnClosedAccount({ settlementId: cmd.settlementId, amount: cmd.amount })],
  },

  evolve: {
    AccountOpened: (_, e) => ({
      _tag: "Open" as const,
      customerId: e.customerId,
      owner: e.owner,
      balance: 0,
      frozen: null,
      today: { day: "", withdrawn: 0 },
    }),
    OwnerChanged: (s, e) => open.modify((o) => ({ ...o, customerId: e.customerId }))(s),
    MoneyDeposited: (s, e) => Optic.replace(s, balance, e.balanceAfter),
    TransferDebited: (s, e) => Optic.replace(s, balance, e.balanceAfter),
    TransferCredited: (s, e) => Optic.replace(s, balance, e.balanceAfter),
    TransferRefunded: (s, e) => Optic.replace(s, balance, e.balanceAfter),
    SettlementReceived: (s, e) => Optic.replace(s, balance, e.balanceAfter),
    MoneyWithdrawn: (s, e, { at }) =>
      open.modify((o) => {
        const day = dayOf(at);
        const withdrawn = (o.today.day === day ? o.today.withdrawn : 0) + e.amount;
        return { ...o, balance: e.balanceAfter, today: { day, withdrawn } };
      })(s),
    AccountFrozen: (s, e) => Optic.replace(s, frozen, e.reason),
    AccountClosed: () => ({ _tag: "Closed" as const }),
    RefundStranded: (s) => s,
    SettlementOnClosedAccount: (s) => s,
  },

  reply: {
    DepositMoney: (s) => ({ balance: s._tag === "Open" ? s.balance : 0 }),
    WithdrawMoney: (s) => ({ balance: s._tag === "Open" ? s.balance : 0 }),
  },
  // Clients may read and watch the account itself (its state and committed
  // events) through an Api, judged like a view against its current state.
  read: {
    middleware: [Session],
    rejects: [NotOwner],
    validate: Effect.fn(function* (_request, s) {
      yield* mustOwn(s._tag === "Open" ? s.customerId : null);
    }),
  },
}) {}
