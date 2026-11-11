# PSL-first Prisma and Effect

This example deploys the same Worker, Hyperdrive, and Neon application as
[the TypeScript-first example](../cloudflare-neon-prisma). Its authoritative schema
is `src/prisma/contract.psl`. There is no handwritten TypeScript contract.

`prisma.config.ts` registers `withEffect` on Prisma's ORM configuration. Generation
emits canonical `contract.json` and `contract.d.ts` plus a thin `makeDatabase`
factory and standalone Effect row schemas:

```ts
import { makeDatabase } from "./prisma/generated/client.ts";
import { schemas } from "./prisma/generated/schemas.ts";

const db = yield* makeDatabase(connection.connectionString);
const users = yield* db.orm.public.User.all();
```

`src/Api.ts` validates newly created rows through `schemas.public.User`. The schema
module can also be used without a database client. These are scalar database row
validators, not create inputs or public API definitions.

## Run

From the repository root, install dependencies with `pnpm install`, then:

```sh
cd examples/cloudflare-neon-prisma-psl
pnpm generate
pnpm exec tsc --noEmit
pnpm deploy
pnpm test
pnpm destroy
```

Configure Alchemy's Cloudflare and Neon credentials first. The tests deploy real
resources and clean them up. Set `ALCHEMY_PROFILE=testing` when using that profile.
`deploy` and `dev` regenerate before loading the application. Generation itself
is offline; Prisma migration planning and application happen during deployment.

For source edits, run `pnpm generate:watch` alongside your development process.
Run generation before type checking and bundling in CI. Do not edit generated
files. This is Alchemy's Prisma 8 contract consumer, not a Prisma 7 generator block.
