# cloudflare-domain

A bank built with `@alchemy.run/domain`: customers, accounts and transfers modelled as aggregates, commands, events, views, policies, a saga, projections and streams; hosted on Cloudflare Durable Objects; driven from a foldkit app; traced end to end into Axiom.

The docs at [alchemy.run/domain](https://alchemy.run/domain) are written around this project, and quote its files.

## Layout

```text
packages/
  domain/   @bank/domain   the model: one <Noun>.<kind>.ts per building block, by subdomain, plus its stories
  server/   @bank/server   the Worker that hosts it, middleware, Stripe/Sift/D1 adapters, Axiom telemetry
  web/      @bank/web      the foldkit app and its Worker
alchemy.run.ts             the stack: the bank Worker and the app
test/integ.test.ts         deploys the stack and drives it
```

See [Project layout](https://alchemy.run/domain/project-layout) for the conventions.

## Run the tests

```sh
pnpm --filter @bank/domain test   # stories: the whole model, in memory
pnpm --filter @bank/server test   # the Apis, in memory
pnpm --filter @bank/web test      # the foldkit app
```

## Deploy

The stack needs Cloudflare, Stripe (test mode) and Axiom credentials: an alchemy profile with Cloudflare and Stripe, and `AXIOM_TOKEN` in the environment.

```sh
pnpm deploy            # or: pnpm dev, to run it locally
pnpm test:integ        # deploy, drive it, destroy it
```

Traces land in `bank-<stage>-traces` in Axiom: one trace per click, from the app's command through every policy and Durable Object it reaches. See [Observability](https://alchemy.run/domain/observability).
