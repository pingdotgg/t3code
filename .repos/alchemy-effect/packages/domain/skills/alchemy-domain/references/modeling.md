# Breaking requirements into building blocks

Work from the language of the business. Write the requirements as sentences, then mark each one.

## 1. List the facts

Every past-tense statement the business cares about is an event. "The customer withdrew money" becomes `MoneyWithdrawn { amount, balanceAfter }`. An event carries what changed and what a reader needs (here `balanceAfter`, so views don't recompute). Name it from the business's point of view, never as a CRUD verb (`AccountUpdated` is a smell).

More: [Event](https://alchemy.run/domain/event).

## 2. Find the decisions

Each event is produced by a command that someone asks for: `WithdrawMoney { amount }`. Ask what can refuse it. Each answer is a rejection carrying the evidence (`InsufficientFunds { balance, requested }`, `DailyLimitExceeded { remaining }`). Name commands `<Verb><Noun>`.

More: [Command](https://alchemy.run/domain/command).

## 3. Draw consistency boundaries

Group the commands by what must be checked together in one transaction. That group is an aggregate, keyed by an id (`Account` keyed by `AccountId`). Its state holds only what its decisions need. Keep aggregates small: one instance is one writer, and there are no transactions across instances.

When a rule spans instances, pick one of these:

- **Invariant-shaped aggregate.** Uniqueness of a username across customers becomes `UsernameClaim`, keyed by the username. Two claims race on one instance and exactly one wins.
- **Reserve, then commit.** A policy claims first (`ClaimUsername`) and only then confirms (`ConfirmRegistration`), or rejects (`RejectRegistration`).
- **Deadline.** A process that waits for a decision schedules a command that can't be rejected (`ExpireTransfer`), on the same aggregate as the decision, so exactly one of approve and expire wins.

More: [Aggregate](https://alchemy.run/domain/aggregate), [Domain Model: Each command goes to one instance](https://alchemy.run/domain/model#each-command-goes-to-one-instance).

## 4. Answer the questions

Every screen or report is a view, keyed by what it's about: `AccountSummary` keyed by account, `CustomerDashboard` keyed by customer. A view folds events from one or more aggregates (or other views) into state. It can also emit its own events (`Statement` turns six money events into `StatementLine`). Route one event to several keys with named routes in `keyOf`, e.g. a transfer shows on both accounts.

A view is a security boundary. Its `validate` judges every read from who is asking. Make a separate view per audience instead of filtering by caller.

More: [View](https://alchemy.run/domain/view).

## 5. Find the reactions

"Whenever X, do Y" is a policy, listening to an aggregate or a view. "When a customer registers, open their main account" is `MainAccountProvisioning` on `CustomerRegistered`, sending `OpenAccount`. A policy has no session, so it provides the request context its commands need (e.g. `CurrentActor` = system).

More: [Policy](https://alchemy.run/domain/policy).

## 6. Find the processes

A reaction with several steps, waits, or undo is a saga: an Effect workflow keyed by the aggregate it's about. "Move money: debit, credit; if the credit fails, refund; large transfers wait for approval" is `ExecuteTransfer`. A policy starts it on `TransferRequested` and signals it on `TransferApproved`. Each step is an `Activity` that sends one command. `withCompensation` undoes a step, and `DurableDeferred` waits for a signal.

More: [Saga](https://alchemy.run/domain/saga).

## 7. Find what's outside

Calls to other systems are external systems: typed operations declared in the domain and implemented in the server (`FraudCheck.score`, `Payments.refund`). Writes to stores outside the model are projections (`Ledger` writes rows through a `LedgerStore` port). A per-key log that clients read is a stream (`AccountCard`), written by a projection.

More: [External System](https://alchemy.run/domain/external-system).

## 8. Decide who sees what

Group commands and reads into Apis by audience (`CustomerApi`, `SupportApi`). Middleware authenticates (`Session` provides `CurrentActor`; `MfaChallenge` guards sensitive commands). Each command's `decide` and each read's `validate` authorizes against the current state.

More: [Views as security boundaries](https://alchemy.run/domain/view-security).

## Smells

- A command that touches two aggregates. Split it, and connect the parts with a policy or a saga.
- A view that filters by caller. Make one view per audience.
- A policy that waits for a result. Use a saga, and react to the events it records.
- An event named after a field change (`BalanceSet`). Name the business fact instead.
- A rejection without evidence. Add the fields a client needs to explain it.
