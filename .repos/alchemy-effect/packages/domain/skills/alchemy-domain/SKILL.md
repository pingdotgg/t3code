---
name: alchemy-domain
description: Build backends with @alchemy.run/domain (domain-driven design on Effect) - turn requirements into aggregates, commands, events, rejections, views, policies, sagas, projections, streams, external systems and Apis; lay them out in a monorepo (domain / server / web packages, kind-suffixed files); test them with stories; host them on Cloudflare Durable Objects with alchemy; and drive them from a foldkit frontend. Use when designing or changing an @alchemy.run/domain model, adding a building block, wiring hosting or a frontend, or reviewing such code.
---

# Building with @alchemy.run/domain

`@alchemy.run/domain` models a backend as typed messages and pure state transitions. Commands are decided by aggregates, which record events. Views fold events into read models. Policies react to events. Sagas run long processes. Projections write outside the model. The same model runs in memory for tests and on Cloudflare Durable Objects in production.

Docs: https://alchemy.run/domain, with every page listed in https://alchemy.run/llms.txt. Every section here and in the reference files ends with a More link to the docs page that covers it in depth. A complete reference project: `examples/cloudflare-domain` in the alchemy repo (a bank with a foldkit app).

## Workflow

Work in this order. Each step has a reference file with templates.

1. **Break the requirements down** into building blocks. See [references/modeling.md](references/modeling.md).
2. **Lay out the monorepo**: a domain package, a server package, a web package, with one kind-suffixed file per block. See [references/layout.md](references/layout.md).
3. **Write each block** from its template. See [references/building-blocks.md](references/building-blocks.md).
4. **Specify behavior with stories** before and while you implement it. See [references/testing.md](references/testing.md).
5. **Host the model** on Cloudflare from the server package, export its traces, and deploy with one alchemy stack. See [references/hosting.md](references/hosting.md).
6. **Drive it from foldkit** in the web package. See [references/frontend.md](references/frontend.md).

More: [Tutorial, part 1](https://alchemy.run/domain/tutorial/part-1).

## From requirements to building blocks

Read the requirements as a story of facts, and name each kind of thing you find:

- A fact the business records, named in the past tense (`MoneyWithdrawn`): an **Event**.
- A request to change something, named `<Verb><Noun>` (`WithdrawMoney`): a **Command**.
- A way a request is refused (`InsufficientFunds`): a **Rejection**.
- A thing whose rules must hold in one transaction (one account's balance): an **Aggregate**. It decides commands against its state.
- A question someone asks (balance, statement, dashboard): a **View**, keyed by what it's about.
- "Whenever X happens, do Y": a **Policy**.
- A process with steps, waits and undo (move money: debit, credit, refund on failure): a **Saga**, started by a policy.
- Something outside the model you call (fraud scoring, payments): an **External System**.
- Writes to a store outside the model (a ledger table): a **Projection**. An ordered, readable log per key (account cards): a **Stream** that a projection appends to.
- Who can do and see what: an **Api** listing commands and reads, with **middleware** (sessions, MFA) and each block's `decide` or `validate` authorizing.

A rule that spans aggregates never becomes a cross-aggregate transaction. Give the invariant its own aggregate, keyed by what it protects (`UsernameClaim` keyed by username). Or reserve first and commit after, in a policy or saga, with a deadline for anything that waits.

More: [What is Domain-Driven Design?](https://alchemy.run/domain/what-is-ddd), [Domain Model](https://alchemy.run/domain/model).

## Conventions

- **One block per file, named `<Noun>.<kind>.ts`.** The kinds are `.aggregate`, `.command`, `.view`, `.policy`, `.saga`, `.projection`, `.stream`, `.external`, `.api` and `.model`. Plus `.middleware`, `.context` and `.rejection`. An aggregate's id lives in `<Aggregate>.id.ts` next to it. Plain values (`Money.ts`) and helpers keep plain names.
- **A command file holds the command, the events it records, and the rejections only it returns.** A rejection or event used by several commands gets its own file.
- **A block's implementation sits in its file** (`TransferExecutionLive` in `TransferExecution.policy.ts`), unless it touches infrastructure. Then it lives in the server package.
- **Folders are subdomains** (`Account/`, `Transfer/`). The model, Apis, middleware and request context sit at the package root.
- **The domain package imports only `@alchemy.run/domain` and `effect`.** Cloudflare, Stripe, databases and HTTP session handling belong to the server package.
- **One domain package per model (bounded context).** A second model is a second domain package; one server can host several.

More: [Project layout](https://alchemy.run/domain/project-layout).

## Rules that keep a model correct

- `decide` is pure, or an `Effect.fn` that reads only what its command's middleware provides (`yield* CurrentActor`). It returns events or a rejection; it never performs I/O.
- `evolve` only applies an event to state. It never decides anything. It and `reply` are total: they cover every state and never fail, because `decide` already refused what can't happen. Keep a state the event can't follow (`s._tag === "Open" ? { ...s, balance: e.balanceAfter } : s`), never a guard that throws.
- Events carry the outcome `decide` worked out (`balanceAfter`), so `evolve` copies it instead of repeating a rule.
- Every rejection a command can return is listed in its `rejects`. Callers handle each one with `Effect.catchTag`.
- Policies and projections run at least once. Make their effects idempotent: commands sent from a handler get deterministic ids, and stores key rows by `stream:seq`.
- Don't wait for a saga in a policy. `start` it, keyed by the aggregate it's about, and react to the events its steps record.
- A handler resolves its dependencies once in `toLayer` and requires nothing per call.
- Build one Layer and provide it once (`Layer.mergeAll`, `Layer.provide`). Never chain `Effect.provide`.
- Never `throw`. Fail with tagged errors (`Domain.Rejection`, `Schema.TaggedError`).
- Tracing is automatic. Record payload values only through a declaration's `attributes`, or with `Effect.annotateCurrentSpan` in an effectful handler. Make secrets `Schema.Redacted`, so they never reach a trace or a log.
- Test what the model does, through stories: events, replies, rejections, views and saga outcomes. Don't test a saga's internal steps.

More: [Domain Model: The aggregate decides, and everything commits at once](https://alchemy.run/domain/model#the-aggregate-decides-and-everything-commits-at-once), [Cloudflare: Count on these guarantees](https://alchemy.run/domain/cloudflare#count-on-these-guarantees).

## Checklist for a change

1. Name the new facts, commands and rejections. Put each command in its own `<Command>.command.ts` with its events and rejections.
2. Add the command to its aggregate's `commands`, with a `decide` branch for it and an `evolve` branch for each event.
3. Update the views, policies and projections that care about the new events.
4. Expose it through an Api, if a client sends or reads it, with the middleware it needs.
5. Write stories for the happy path, every rejection, and every policy reaction.
6. Run the domain package's tests, with one that expects `Domain.verify(Model)` to be empty. Then type-check the monorepo (`tsc -b`) and run the server and web tests.
