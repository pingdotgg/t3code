# Monorepo layout

```text
my-app/
  package.json            workspace root: deploy scripts, the stack
  pnpm-workspace.yaml     packages: ["packages/*"]
  tsconfig.json           solution file: references every package + tsconfig.stack.json
  tsconfig.stack.json     alchemy.run.ts and root tests
  alchemy.run.ts          the stack: server Worker + web app
  test/integ.test.ts      deploys the stack and drives it
  packages/
    domain/               @acme/domain - the pure model (imports @alchemy.run/domain + effect only)
      src/
        Account/
          Account.aggregate.ts
          Account.id.ts
          OpenAccount.command.ts      command + its events + its rejections
          WithdrawMoney.command.ts
          NotOpen.rejection.ts        shared by several commands
          AccountSummary.view.ts
          Statement.view.ts
        Transfer/
          Transfer.aggregate.ts
          RequestTransfer.command.ts
          ExecuteTransfer.saga.ts
          TransferExecution.policy.ts
        Fraud/
          FraudCheck.external.ts      declaration only
          FraudReview.policy.ts
        Ledger/
          Ledger.projection.ts        projection + its Live handler
          LedgerStore.ts              the port it writes through (+ a memory implementation)
        Session.middleware.ts         RpcMiddleware declaration + its error + client helper
        CurrentActor.context.ts       Domain.RequestContext
        CustomerApi.api.ts
        Bank.model.ts                 Domain.Model + the handlers Layer
      test/Bank.story.test.ts
    server/               @acme/server - hosting and adapters
      src/
        BankWorker.ts                 Cloudflare.Worker hosting the model
        Session.ts                    SessionLive (verifies sessions), sign-in route
        Fraud/SiftFraudCheck.ts       FraudCheck.toLayer(...) - real adapter
        Ledger/D1LedgerStore.ts       LedgerStore over D1
      test/CustomerApi.test.ts        Api clients over in-memory hosting
    web/                  @acme/web - foldkit app
      index.html
      vite.config.ts
      src/Bank.ts                     Model / Message / update / view / Commands / Subscriptions
      src/entry.ts                    Runtime.run with the Api client as a resource
      src/worker.ts                   serves the build, forwards /api to the server
      test/Bank.test.ts               foldkit stories
```

## What goes where

| Package | Holds | May import |
| --- | --- | --- |
| domain | every Domain building block, Apis, middleware declarations, request contexts, ports (`Context.Service` interfaces) with memory implementations, stories | `@alchemy.run/domain`, `@alchemy.run/domain/Story` (tests), `effect` |
| server | the Worker, `*Live` middleware, external system adapters, port implementations (D1, HTTP), event sources (Stripe webhooks), Api tests | domain, `@alchemy.run/cloudflare`, `@alchemy.run/cloudflare/Domain`, provider packages |
| web | the foldkit app and its Worker | domain (Api, ids, value schemas), `@alchemy.run/domain` (client protocols), `foldkit` |

Split a file when it mixes the two sides. For example, `Session.middleware.ts` (the domain declares it) and `Session.ts` (the server implements it).

More: [Project layout: Keep the model in its own package](https://alchemy.run/domain/project-layout#keep-the-model-in-its-own-package).

## Package manifests

Each package exports its source files by path, so imports name the file they come from:

```json
// packages/domain/package.json
{
  "name": "@acme/domain",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "exports": { "./*": "./src/*.ts" },
  "scripts": { "test": "vitest run" },
  "dependencies": { "alchemy": "^2", "effect": "^4" },
  "devDependencies": { "@effect/vitest": "^4", "vitest": "^4" }
}
```

```ts
// packages/server/src/BankWorker.ts
import { Bank, BankHandlers } from "@acme/domain/Bank.model";
import { CustomerApi } from "@acme/domain/CustomerApi.api";
```

Inside a package, import with relative paths and the `.ts` extension (`./Account.id.ts`). Across packages, import without the extension (`@acme/domain/Account/Account.id`). Don't add barrel files.

`server` depends on `@acme/domain` (`workspace:*`), `alchemy` and `effect`. `web` depends on `@acme/domain`, `alchemy`, `effect`, `foldkit` and `@effect/platform-browser`, with `vite`, `@foldkit/vite-plugin` and `vitest` as devDependencies. The root depends on `@acme/server` and `alchemy`.

## TypeScript

Each package has its own `tsconfig.json`, with `noEmit`, `module: "Preserve"`, `moduleResolution: "Bundler"` and `allowImportingTsExtensions` (or `rewriteRelativeImportExtensions`). The root `tsconfig.json` is a solution file:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/domain" },
    { "path": "./packages/server" },
    { "path": "./packages/web" },
    { "path": "./tsconfig.stack.json" }
  ]
}
```

Type-check everything with `tsc -b`.

## The stack

```ts
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import BankWorker from "@acme/server/BankWorker";

export default Alchemy.Stack(
  "Bank",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const bank = yield* BankWorker;
    const app = yield* Cloudflare.Website.Foldkit("BankApp", {
      rootDir: "packages/web",
      main: "src/worker.ts",
      env: { BANK: bank },
      assets: { runWorkerFirst: ["/api", "/api/*"] },
    });
    return { api: bank.url.as<string>(), app: app.url.as<string>() };
  }),
);
```

Paths in resource props, such as D1 `migrations` and Website `rootDir`, resolve from the directory `alchemy deploy` runs in: the repo root.

More: [Cloudflare: Deploy it](https://alchemy.run/domain/cloudflare#deploy-it).

## Several models

Each bounded context is its own domain package (`packages/banking`, `packages/lending`) with its own `*.model.ts`. They talk through policies that call each other's Apis or external system declarations, never by importing each other's aggregates. One server package can host several models; give each its own Worker or merge their layers into one.

More: [Project layout: Add a package per model](https://alchemy.run/domain/project-layout#add-a-package-per-model), [Domain Model: Keep one language per model](https://alchemy.run/domain/model#keep-one-language-per-model).
