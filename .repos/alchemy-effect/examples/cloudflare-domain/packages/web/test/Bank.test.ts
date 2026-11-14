import { AccountId } from "@bank/domain/Account/Account.id";
import { StatementLine } from "@bank/domain/Account/Statement.view";
import { CustomerId } from "@bank/domain/Customer/Customer.id";
import { expect, test } from "@effect/vitest";
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import {
  Deliver,
  init,
  type Line,
  Message,
  type Model,
  BankClient,
  SaveIntents,
  shownBalance,
  update,
} from "../src/Bank.ts";

const earlier: Line = {
  commandId: "earlier",
  kind: "deposit",
  amount: 5_000,
  balance: Option.some(5_000),
  ack: "Confirmed",
  reason: Option.none(),
};

const account: Model = {
  customerId: CustomerId.make("c-1"),
  accountId: AccountId.make("c-1-main"),
  commandIds: { session: "s", sent: 0 },
  summaryCursor: Option.none(),
  statementCursor: Option.none(),
  feedState: "Live",
  online: true,
  balance: Option.some(5_000),
  lines: [earlier],
  error: Option.none(),
};

const saved = Command.resolve(SaveIntents, Message.CompletedSaveIntents());

const accepted = (commandId: string) =>
  Message.CompletedDeliver({
    outcomes: [{ commandId, result: "Accepted", reason: Option.none() }],
  });

const deposited = (commandId: string, balance: number) =>
  Message.ReceivedLine({
    commandId,
    line: StatementLine.make({ kind: "deposit", amount: 1_000, balance }),
    cursor: 1,
  });

const acks = (model: Model) => model.lines.map((l) => [l.commandId, l.ack]);

// VARIANT 1: online, with optimistic UI.

test("a deposit shows at once as pending; its event confirms it", () =>
  story(
    update,
    given(account),
    message(Message.ClickedDeposit()),
    saved,
    model((model) => {
      expect(Option.getOrThrow(Array.head(model.lines))).toMatchObject({
        commandId: "s:0",
        ack: "Pending",
        balance: Option.none(),
      });
      expect(shownBalance(model)).toEqual(Option.some(6_000));
    }),
    Command.resolve(Deliver, accepted("s:0")),
    saved,
    // Accepted is not acknowledged: still pending until the statement says so.
    model((model) => expect(Option.getOrThrow(Array.head(model.lines)).ack).toBe("Pending")),
    message(deposited("s:0", 6_000)),
    saved,
    model((model) => {
      expect(acks(model)).toEqual([
        ["s:0", "Confirmed"],
        ["earlier", "Confirmed"],
      ]);
      expect(shownBalance(model)).toEqual(Option.some(6_000));
    }),
  ));

test("the event can arrive before the reply; the reply changes nothing", () =>
  story(
    update,
    // The deposit is in flight: its line is pending, its reply not yet back.
    given(
      modifyFields(account, {
        commandIds: () => ({ session: "s", sent: 1 }),
        lines: () => [
          { ...earlier, commandId: "s:0", amount: 1_000, balance: Option.none(), ack: "Pending" },
          earlier,
        ],
      }),
    ),
    message(deposited("s:0", 6_000)),
    saved,
    message(accepted("s:0")),
    saved,
    model((model) => {
      expect(Option.getOrThrow(Array.head(model.lines))).toMatchObject({
        commandId: "s:0",
        ack: "Confirmed",
        balance: Option.some(6_000),
      });
      expect(shownBalance(model)).toEqual(Option.some(6_000));
    }),
  ));

test("a rejected withdrawal is marked rejected and no longer moves the balance", () =>
  story(
    update,
    given(account),
    message(Message.ClickedWithdraw()),
    saved,
    model((model) => expect(shownBalance(model)).toEqual(Option.some(4_000))),
    Command.resolve(
      Deliver,
      Message.CompletedDeliver({
        outcomes: [
          { commandId: "s:0", result: "Rejected", reason: Option.some("InsufficientFunds") },
        ],
      }),
    ),
    saved,
    model((model) => {
      expect(Option.getOrThrow(Array.head(model.lines))).toMatchObject({
        ack: "Rejected",
        reason: Option.some("InsufficientFunds"),
      });
      expect(shownBalance(model)).toEqual(Option.some(5_000));
    }),
  ));

test("an event this browser did not ask for lands below its unacknowledged lines", () =>
  story(
    update,
    given(account),
    message(Message.ClickedDeposit()),
    saved,
    Command.resolve(Deliver, accepted("s:0")),
    saved,
    // A transfer arrives from elsewhere while the deposit is in flight.
    message(
      Message.ReceivedLine({
        commandId: "transfer-t-1",
        line: StatementLine.make({ kind: "transfer-in", amount: 2_000, balance: 7_000 }),
        cursor: 1,
      }),
    ),
    saved,
    model((model) => {
      expect(acks(model)).toEqual([
        ["s:0", "Pending"],
        ["transfer-t-1", "Confirmed"],
        ["earlier", "Confirmed"],
      ]);
      expect(shownBalance(model)).toEqual(Option.some(8_000));
    }),
  ));

// VARIANT 2: offline-capable, recording intents.

test("offline, a deposit is queued; back online, it is sent and confirmed", () =>
  story(
    update,
    given(modifyFields(account, { online: () => false })),
    // Nothing is sent while offline: the intent is only kept.
    message(Message.ClickedDeposit()),
    saved,
    model((model) => {
      expect(Option.getOrThrow(Array.head(model.lines))).toMatchObject({
        commandId: "s:0",
        ack: "Queued",
      });
      expect(shownBalance(model)).toEqual(Option.some(6_000));
    }),
    message(Message.WentOnline()),
    model((model) => expect(Option.getOrThrow(Array.head(model.lines)).ack).toBe("Pending")),
    Command.resolve(Deliver, accepted("s:0")),
    saved,
    message(deposited("s:0", 6_000)),
    saved,
    model((model) =>
      expect(Option.getOrThrow(Array.head(model.lines))).toMatchObject({ ack: "Confirmed" }),
    ),
  ));

test("a send that cannot reach the server is queued, and so is everything after it", () =>
  story(
    update,
    given(account),
    message(Message.ClickedDeposit()),
    saved,
    Command.resolve(
      Deliver,
      Message.CompletedDeliver({
        outcomes: [{ commandId: "s:0", result: "Queued", reason: Option.none() }],
      }),
    ),
    saved,
    // A later withdrawal waits behind the queued deposit instead of overtaking it.
    message(Message.ClickedWithdraw()),
    saved,
    model((model) =>
      expect(acks(model)).toEqual([
        ["s:1", "Queued"],
        ["s:0", "Queued"],
        ["earlier", "Confirmed"],
      ]),
    ),
  ));

test("a queued withdrawal the account refuses on sync stops counting", () =>
  story(
    update,
    given(modifyFields(account, { online: () => false })),
    message(Message.ClickedWithdraw()),
    saved,
    model((model) => expect(shownBalance(model)).toEqual(Option.some(4_000))),
    message(Message.WentOnline()),
    Command.resolve(
      Deliver,
      Message.CompletedDeliver({
        outcomes: [
          { commandId: "s:0", result: "Rejected", reason: Option.some("InsufficientFunds") },
        ],
      }),
    ),
    saved,
    model((model) => {
      expect(Option.getOrThrow(Array.head(model.lines))).toMatchObject({
        ack: "Rejected",
        reason: Option.some("InsufficientFunds"),
      });
      expect(shownBalance(model)).toEqual(Option.some(5_000));
    }),
  ));

test("intents from an earlier page load are sent, oldest first, when the app boots", () => {
  const bankInit = init({
    customerId: CustomerId.make("c-1"),
    session: "next",
    online: true,
    intents: [
      { commandId: "old:0", kind: "deposit", amount: 1_000 },
      { commandId: "old:1", kind: "withdrawal", amount: 500 },
    ],
  });
  expect(acks(bankInit.model)).toEqual([
    ["old:1", "Pending"],
    ["old:0", "Pending"],
  ]);
  expect(bankInit.commands).toHaveLength(1);
});

test("an intent the server already applied is confirmed by the statement's history", () =>
  story(
    update,
    given(
      modifyFields(account, {
        lines: () => [
          { ...earlier, commandId: "old:0", amount: 1_000, balance: Option.none(), ack: "Pending" },
          earlier,
        ],
      }),
    ),
    // The statement replays history; the earlier page load's deposit is in it.
    message(deposited("old:0", 6_000)),
    saved,
    // Its resend is answered from the account's stored receipt: no second deposit.
    message(accepted("old:0")),
    saved,
    model((model) => {
      expect(Option.getOrThrow(Array.head(model.lines))).toMatchObject({
        commandId: "old:0",
        ack: "Confirmed",
      });
      expect(shownBalance(model)).toEqual(Option.some(6_000));
    }),
  ));

test("a new customer opens their account; it appears through the subscription", () =>
  story(
    update,
    given(modifyFields(account, { balance: () => Option.none(), lines: () => [] })),
    message(Message.ClickedRegister()),
    Command.resolve(
      BankClient.RegisterCustomer,
      BankClient.Message.SucceededRegisterCustomer({
        commandId: "s:0",
        reply: undefined,
        receipt: { stream: "Customer/c-1", version: 1 },
      }),
    ),
    model((model) => expect(model.balance).toEqual(Option.none())),
    message(Message.ReceivedBalance({ balance: Option.some(0), cursor: 1 })),
    model((model) => expect(model.balance).toEqual(Option.some(0))),
  ));

test("a denied line allows new intents and retries with the same id", () => {
  const denied = modifyFields(account, {
    lines: () => [
      { ...earlier, commandId: "denied", ack: "Denied", reason: Option.some("MfaRequired") },
      earlier,
    ],
  });
  const deposit = update(denied, Message.ClickedDeposit());
  expect(Option.getOrThrow(Array.head(deposit.model.lines)).ack).toBe("Pending");
  const retry = update(denied, Message.ClickedRetryLine({ commandId: "denied" }));
  expect(Option.getOrThrow(Array.head(retry.model.lines))).toMatchObject({
    commandId: "denied",
    ack: "Pending",
    reason: Option.none(),
  });
  expect(retry.commands?.find((command) => command.name === "Deliver")?.args).toMatchObject({
    intents: [{ commandId: "denied" }],
  });
});

test("stale snapshot Flags fall back to empty state", () => {
  const bankInit = init({
    customerId: account.customerId,
    session: "fresh",
    online: false,
    intents: [],
    summary: { state: { oldBalance: 1 }, cursor: 2 },
  });
  expect(bankInit.model.balance).toEqual(Option.none());
  expect(bankInit.model.summaryCursor).toEqual(Option.none());
});

test("a caught-up marker records the cursor and live status", () => {
  const caughtUp = update(account, Message.CaughtUpStatement({ cursor: 5 }));
  expect(caughtUp.model.statementCursor).toEqual(Option.some(5));
  expect(caughtUp.model.feedState).toBe("Live");
});
