# TypeScript-first Prisma and Effect

This example deploys a Cloudflare Worker, Hyperdrive connection, and Neon database.
`src/prisma/contract.ts` is the authoritative schema. The application imports it
directly; query types need no generated application imports.

```ts
const db = yield* Postgres(connection.connectionString, { contract });
const users = yield* db.orm.public.User.all();
```

`src/Api.ts` also derives row validators with `makeSchemas(contract)` and validates
created rows. These are database row schemas, not public API definitions or create
inputs. The Arktype bootstrap in `src/prisma/validation.ts` is required when the
native authoring module runs in a Worker.

## Run

From the repository root, install dependencies with `pnpm install`, then:

```sh
cd examples/cloudflare-neon-prisma
pnpm deploy
pnpm test
pnpm destroy
```

Configure Alchemy's Cloudflare and Neon credentials first. The tests deploy real
resources and clean them up. Set `ALCHEMY_PROFILE=testing` when using that profile.
The deployment plans and applies Prisma migration packages separately from runtime
queries.

## Optional standalone schemas

```sh
pnpm generate
pnpm generate:watch
```

`prisma.config.ts` selects `{ client: false, schemas: true }`. This emits standalone
Effect schemas for consumers that should not import the contract authoring code.
It does not connect to Neon or migrate a database.

Compare [the PSL-first example](../cloudflare-neon-prisma-psl): it uses the same
query API, but authors `contract.psl` and imports generated `makeDatabase`.
