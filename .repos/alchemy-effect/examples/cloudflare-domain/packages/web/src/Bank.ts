import type * as Domain from "@alchemy.run/domain";
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import { AccountId, mainAccountId } from "@bank/domain/Account/Account.id";
import { StatementLine } from "@bank/domain/Account/Statement.view";
import { CustomerId } from "@bank/domain/Customer/Customer.id";
import { Username } from "@bank/domain/Customer/Username";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Subscription, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

type Bank = Domain.Api.ClientKey<"CustomerApi">;
export const BankClient = DomainFoldkit.make(CustomerApi);

// MODEL

export const Intent = Schema.Struct({
  commandId: Schema.String,
  kind: Schema.Literals(["deposit", "withdrawal"]),
  amount: Schema.Number,
});
export type Intent = typeof Intent.Type;
export const intentsKey = (customerId: CustomerId) => `bank:intents:${customerId}`;

export const Flags = Schema.Struct({
  customerId: CustomerId,
  session: Schema.String,
  online: Schema.Boolean,
  intents: Schema.Array(Intent),
  summary: Schema.optional(Schema.Unknown),
});
export type Flags = typeof Flags.Type;

export const Ack = Schema.Literals(["Pending", "Queued", "Confirmed", "Rejected", "Denied"]);
export type Ack = typeof Ack.Type;
export const Line = Schema.Struct({
  commandId: Schema.String,
  kind: StatementLine.fields.kind,
  amount: Schema.Number,
  balance: Schema.Option(Schema.Number),
  ack: Ack,
  reason: Schema.Option(Schema.String),
});
export type Line = typeof Line.Type;

export const Model = Schema.Struct({
  customerId: CustomerId,
  accountId: AccountId,
  commandIds: DomainFoldkit.CommandIds,
  online: Schema.Boolean,
  balance: Schema.Option(Schema.Number),
  summaryCursor: Schema.Option(Schema.Number),
  statementCursor: Schema.Option(Schema.Number),
  feedState: Schema.Literals(["CatchingUp", "Live", "Failed"]),
  lines: Schema.Array(Line),
  error: Schema.Option(Schema.String),
});
export type Model = typeof Model.Type;

export const Outcome = Schema.Struct({
  commandId: Schema.String,
  result: Schema.Literals(["Accepted", "Queued", "Rejected", "Denied"]),
  reason: Schema.Option(Schema.String),
});
export type Outcome = typeof Outcome.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedRegister: {},
  ClickedDeposit: {},
  ClickedWithdraw: {},
  ClickedRetryLine: { commandId: Schema.String },
  ReceivedBankResult: { result: BankClient.Message },
  CompletedDeliver: { outcomes: Schema.Array(Outcome) },
  CompletedSaveIntents: {},
  WentOnline: {},
  WentOffline: {},
  ReceivedBalance: { balance: Schema.Option(Schema.Number), cursor: Schema.Number },
  ReceivedLine: { commandId: Schema.String, line: StatementLine, cursor: Schema.Number },
  CaughtUpStatement: { cursor: Schema.Number },
  FailedWatchSummary: { reason: Schema.String },
  FailedReadStatement: { reason: Schema.String },
});
export type Message = typeof Message.Type;

// COMMAND

const outcomeOfFailure = (
  commandId: string,
  failure: DomainFoldkit.Failure<Domain.Api.CommandsOf<typeof CustomerApi>>,
) =>
  Match.value(failure).pipe(
    Match.withReturnType<Effect.Effect<Outcome, { readonly _tag: "Unknown" }>>(),
    Match.tagsExhaustive({
      Rejected: ({ rejection }) =>
        Effect.succeed({ commandId, result: "Rejected", reason: Option.some(rejection._tag) }),
      Denied: ({ error }) =>
        Effect.succeed({ commandId, result: "Denied", reason: Option.some(error._tag) }),
      Unknown: (failure) => Effect.fail(failure),
    }),
  );

const deliver = (accountId: AccountId, intent: Intent) => {
  const { commandId, amount } = intent;
  const send: Command.Command<typeof BankClient.Message.Type, never, Bank> =
    intent.kind === "deposit"
      ? BankClient.DepositMoney({ target: accountId, input: { amount }, commandId })
      : BankClient.WithdrawMoney({ target: accountId, input: { amount }, commandId });
  return send.effect.pipe(
    Effect.flatMap((result) =>
      Match.value(result).pipe(
        Match.withReturnType<Effect.Effect<Outcome, { readonly _tag: "Unknown" }>>(),
        Match.tag("FailedDepositMoney", "FailedWithdrawMoney", ({ failure }) =>
          outcomeOfFailure(commandId, failure),
        ),
        Match.orElse(() =>
          Effect.succeed({ commandId, result: "Accepted", reason: Option.none() }),
        ),
      ),
    ),
    Effect.retry({ schedule: Schedule.exponential("200 millis"), times: 3 }),
    Effect.catch(() =>
      Effect.succeed<Outcome>({ commandId, result: "Queued", reason: Option.none() }),
    ),
  );
};

export const Deliver = Command.define("Deliver", {
  args: { accountId: AccountId, intents: Schema.Array(Intent) },
  messages: [Message.CompletedDeliver],
  execute: Effect.fn(function* ({ accountId, intents }) {
    const outcomes: Array<Outcome> = [];
    for (const intent of intents) {
      const outcome = yield* deliver(accountId, intent);
      outcomes.push(outcome);

      if (outcome.result === "Queued") {
        for (const rest of intents.slice(outcomes.length)) {
          outcomes.push({ commandId: rest.commandId, result: "Queued", reason: Option.none() });
        }
        break;
      }
    }
    return Message.CompletedDeliver({ outcomes });
  }),
});

export const SaveIntents = Command.define("SaveIntents", {
  args: { customerId: CustomerId, intents: Schema.Array(Intent) },
  messages: [Message.CompletedSaveIntents],
  execute: ({ customerId, intents }) =>
    Effect.sync(() => {
      localStorage.setItem(intentsKey(customerId), JSON.stringify(intents));
      return Message.CompletedSaveIntents();
    }),
});

// UPDATE

const isIntent = (line: Line): line is Line & { readonly kind: Intent["kind"] } =>
  (line.ack === "Pending" || line.ack === "Queued") &&
  (line.kind === "deposit" || line.kind === "withdrawal");
const intentsOf = (model: Model): Array<Intent> =>
  model.lines
    .filter(isIntent)
    .map(({ commandId, kind, amount }) => ({ commandId, kind, amount }))
    .reverse();
const save = (model: Model) =>
  SaveIntents({ customerId: model.customerId, intents: intentsOf(model) });

const ask = (
  model: Model,
  kind: Intent["kind"],
  amount: number,
): Update.Return<Model, Message, Bank> => {
  const allocation = DomainFoldkit.next(model.commandIds);
  const { commandId } = allocation;
  const isSending = model.online && !model.lines.some((line) => line.ack === "Queued");
  const nextModel = modifyFields(model, {
    commandIds: () => allocation.commandIds,
    error: () => Option.none(),
    lines: (lines) => [
      Line.make({
        commandId,
        kind,
        amount,
        balance: Option.none(),
        ack: isSending ? "Pending" : "Queued",
        reason: Option.none(),
      }),
      ...lines,
    ],
  });
  return {
    model: nextModel,
    commands: [
      save(nextModel),
      ...(isSending
        ? [Deliver({ accountId: model.accountId, intents: [{ commandId, kind, amount }] })]
        : []),
    ],
  };
};

const flush = (model: Model): Update.Return<Model, Message, Bank> => {
  if (!model.online) {
    return { model };
  }
  const queued = intentsOf(model).filter((intent) =>
    model.lines.some((line) => line.commandId === intent.commandId && line.ack === "Queued"),
  );
  if (Array.isArrayEmpty(queued)) {
    return { model };
  }
  const sending = new Set(queued.map((intent) => intent.commandId));
  return {
    model: modifyFields(model, {
      lines: Array.map((line) =>
        sending.has(line.commandId) ? modifyFields(line, { ack: () => "Pending" }) : line,
      ),
    }),
    commands: [Deliver({ accountId: model.accountId, intents: queued })],
  };
};

const delivered = (model: Model, outcomes: ReadonlyArray<Outcome>): Model => {
  const byId = new Map(outcomes.map((outcome) => [outcome.commandId, outcome]));
  return modifyFields(model, {
    lines: Array.map((line) => {
      const outcome = byId.get(line.commandId);
      if (!outcome || line.ack === "Confirmed") {
        return line;
      }
      return Match.value(outcome.result).pipe(
        Match.withReturnType<Line>(),
        Match.when("Accepted", () => line),
        Match.when("Queued", () => modifyFields(line, { ack: () => "Queued" })),
        Match.when("Denied", () =>
          modifyFields(line, { ack: () => "Denied", reason: () => outcome.reason }),
        ),
        Match.when("Rejected", () =>
          modifyFields(line, { ack: () => "Rejected", reason: () => outcome.reason }),
        ),
        Match.exhaustive,
      );
    }),
  });
};

const confirm = (model: Model, commandId: string, line: StatementLine, cursor: number): Model => {
  const confirmed = Line.make({
    commandId,
    kind: line.kind,
    amount: line.amount,
    balance: Option.some(line.balance),
    ack: "Confirmed",
    reason: Option.none(),
  });
  const others = model.lines.filter((line) => line.commandId !== commandId);
  return modifyFields(model, {
    lines: () => [
      ...others.filter((line) => line.ack !== "Confirmed"),
      confirmed,
      ...others.filter((line) => line.ack === "Confirmed"),
    ],
    statementCursor: () => Option.some(cursor),
  });
};

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, Bank>>(message, {
    ClickedRegister: () => {
      const allocation = DomainFoldkit.next(model.commandIds);
      return {
        model: modifyFields(model, { commandIds: () => allocation.commandIds }),
        commands: [
          Command.mapMessage(
            BankClient.RegisterCustomer({
              target: model.customerId,
              input: { name: model.customerId, username: Username.make(model.customerId) },
              commandId: allocation.commandId,
            }),
            (result) => Message.ReceivedBankResult({ result }),
          ),
        ],
      };
    },
    ClickedDeposit: () => ask(model, "deposit", 1_000),
    ClickedWithdraw: () => ask(model, "withdrawal", 1_000),
    ClickedRetryLine: ({ commandId }) => {
      const retry = flush(
        modifyFields(model, {
          lines: Array.map((line) =>
            line.commandId === commandId && line.ack === "Denied"
              ? modifyFields(line, { ack: () => "Queued", reason: () => Option.none() })
              : line,
          ),
        }),
      );
      return { model: retry.model, commands: [save(retry.model), ...(retry.commands ?? [])] };
    },
    ReceivedBankResult: ({ result }) =>
      Match.value(result).pipe(
        Match.withReturnType<Update.Return<Model, Message, Bank>>(),
        Match.tag("FailedRegisterCustomer", ({ failure }) => ({
          model: modifyFields(model, { error: () => Option.some(failure._tag) }),
        })),
        Match.orElse(() => ({ model: modifyFields(model, { error: () => Option.none() }) })),
      ),
    CompletedDeliver: ({ outcomes }) => {
      const nextModel = delivered(model, outcomes);
      return { model: nextModel, commands: [save(nextModel)] };
    },
    CompletedSaveIntents: () => ({ model }),
    WentOnline: () => flush(modifyFields(model, { online: () => true })),
    WentOffline: () => ({
      model: modifyFields(model, { online: () => false, feedState: () => "CatchingUp" }),
    }),
    ReceivedBalance: ({ balance, cursor }) => ({
      model: modifyFields(model, {
        balance: () => balance,
        summaryCursor: () => Option.some(cursor),
      }),
    }),
    ReceivedLine: ({ commandId, line, cursor }) => {
      const nextModel = confirm(model, commandId, line, cursor);
      return { model: nextModel, commands: [save(nextModel)] };
    },
    CaughtUpStatement: ({ cursor }) => ({
      model: modifyFields(model, {
        statementCursor: () => Option.some(cursor),
        feedState: () => "Live",
      }),
    }),
    FailedWatchSummary: ({ reason }) => ({
      model: modifyFields(model, { error: () => Option.some(reason) }),
    }),
    FailedReadStatement: ({ reason }) => ({
      model: modifyFields(model, { error: () => Option.some(reason), feedState: () => "Failed" }),
    }),
  });

// INIT

export const init = (flags: Flags): Update.Return<Model, Message, Bank> => {
  const summary = BankClient.AccountSummary.decodeSnapshotFlags(flags.summary);
  const model = Model.make({
    customerId: flags.customerId,
    accountId: mainAccountId(flags.customerId),
    commandIds: { session: flags.session, sent: 0 },
    online: flags.online,
    balance: Option.flatMap(summary, (snapshot) =>
      Option.map(snapshot.state, (state) => state.balance),
    ),
    summaryCursor: Option.map(summary, (snapshot) => snapshot.cursor),
    statementCursor: Option.none(),
    feedState: "CatchingUp",
    lines: flags.intents
      .map((intent) =>
        Line.make({ ...intent, balance: Option.none(), ack: "Queued", reason: Option.none() }),
      )
      .reverse(),
    error: Option.none(),
  });
  return model.online ? flush(model) : { model };
};

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message, Bank>()((entry) => ({
  connectivity: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.merge(
          Stream.fromEventListener(window, "online").pipe(Stream.as(Message.WentOnline())),
          Stream.fromEventListener(window, "offline").pipe(Stream.as(Message.WentOffline())),
        ),
    },
  ),
  summary: BankClient.AccountSummary.watch({
    key: (model: Model) => model.accountId,
    isEnabled: (model) => model.online,
    toMessage: ({ state, cursor }): Message =>
      Message.ReceivedBalance({ balance: Option.map(state, (summary) => summary.balance), cursor }),
    onFailure: (error): Message => Message.FailedWatchSummary({ reason: error._tag }),
    onDefect: (): Message => Message.FailedWatchSummary({ reason: "Read defect" }),
  }),
  statement: BankClient.Statement.events({
    key: (model: Model) => model.accountId,
    cursor: (model) => model.statementCursor,
    isEnabled: (model) => model.online,
    onEntry: ({ event, envelope }): Message =>
      Message.ReceivedLine({ commandId: envelope.commandId, line: event, cursor: envelope.seq }),
    onCaughtUp: (cursor): Message => Message.CaughtUpStatement({ cursor }),
    onFailure: (error): Message => Message.FailedReadStatement({ reason: error._tag }),
    onDefect: (): Message => Message.FailedReadStatement({ reason: "Read defect" }),
  }),
}));

// VIEW

const signed = (line: Line) =>
  line.kind === "deposit" ||
  line.kind === "transfer-in" ||
  line.kind === "refund" ||
  line.kind === "settlement"
    ? line.amount
    : -line.amount;

export const shownBalance = (model: Model): Option.Option<number> =>
  Option.map(model.balance, (balance) => {
    const confirmed = Option.flatMap(
      Array.findFirst(model.lines, (line) => line.ack === "Confirmed"),
      (line) => line.balance,
    );
    return model.lines
      .filter((line) => line.ack === "Pending" || line.ack === "Queued")
      .reduce(
        (sum, line) => sum + signed(line),
        Option.getOrElse(confirmed, () => balance),
      );
  });
const button = "bg-black text-white hover:bg-gray-700 px-4 py-2";
const cents = (amount: number) => (amount / 100).toFixed(2);
const lineView = (line: Line, h: HtmlBuilder<Message>) => {
  const text = `${line.kind} ${cents(line.amount)}`;
  const item = h.keyed("li");
  return Match.value(line.ack).pipe(
    Match.when("Pending", () =>
      item(line.commandId, [h.Class("text-gray-400 italic")], [`${text}, sending`]),
    ),
    Match.when("Queued", () =>
      item(line.commandId, [h.Class("text-amber-600 italic")], [`${text}, queued until online`]),
    ),
    Match.when("Denied", () =>
      item(
        line.commandId,
        [h.Class("text-amber-600")],
        [
          `${text}, authentication required: ${Option.getOrElse(line.reason, () => "Denied")}`,
          h.button(
            [h.OnClick(Message.ClickedRetryLine({ commandId: line.commandId })), h.Class(button)],
            ["Retry"],
          ),
        ],
      ),
    ),
    Match.when("Rejected", () =>
      item(
        line.commandId,
        [h.Class("text-red-600 line-through")],
        [`${text}, rejected: ${Option.getOrElse(line.reason, () => "Rejected")}`],
      ),
    ),
    Match.when("Confirmed", () =>
      item(
        line.commandId,
        [],
        [
          `${text}, balance ${Option.match(line.balance, { onNone: () => "unknown", onSome: cents })}`,
        ],
      ),
    ),
    Match.exhaustive,
  );
};
export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const balance = shownBalance(model);
  const isUnacknowledged = model.lines.some(
    (line) => line.ack === "Pending" || line.ack === "Queued",
  );
  return {
    title: Option.match(balance, {
      onNone: () => "Bank",
      onSome: (amount) => `Balance: ${cents(amount)}`,
    }),
    body: h.div(
      [h.Class("flex flex-col gap-4 p-8")],
      [
        h.p([], [`Signed in as ${model.customerId}`]),
        ...(model.online
          ? []
          : [
              h.p(
                [h.Class("text-amber-600")],
                ["Offline: changes are kept and sent when you reconnect."],
              ),
            ]),
        ...Option.match(balance, {
          onNone: () => [
            h.button([h.OnClick(Message.ClickedRegister()), h.Class(button)], ["Open my account"]),
          ],
          onSome: (amount) => [
            h.div(
              [
                h.Class(
                  isUnacknowledged ? "text-4xl font-bold text-gray-400" : "text-4xl font-bold",
                ),
              ],
              [isUnacknowledged ? `${cents(amount)} (pending)` : cents(amount)],
            ),
            h.div(
              [h.Class("flex gap-2")],
              [
                h.button([h.OnClick(Message.ClickedDeposit()), h.Class(button)], ["Deposit 10.00"]),
                h.button(
                  [h.OnClick(Message.ClickedWithdraw()), h.Class(button)],
                  ["Withdraw 10.00"],
                ),
              ],
            ),
          ],
        }),
        h.p([], [model.feedState === "Live" ? "Statement is live" : "Statement is catching up"]),
        h.p([h.Class("text-red-600")], [Option.getOrElse(model.error, () => "")]),
        h.ul(
          [],
          model.lines.map((line) => lineView(line, h)),
        ),
      ],
    ),
  };
};
