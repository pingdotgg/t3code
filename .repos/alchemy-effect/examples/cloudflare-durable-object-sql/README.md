# Cloudflare Durable Object SQL

A Worker with a separate SQLite users table for each named Durable Object, using Drizzle and checked-in SQL.

## Run locally

Start at the repository root; run subsequent commands from the example directory.

```sh
pnpm install
cd examples/cloudflare-durable-object-sql
pnpm dev
```

Use the Worker URL printed by Alchemy:

```sh
URL='http://localhost:<port>'

curl -X POST "$URL/objects/team-a/users" \
  -H 'content-type: application/json' \
  -d '{"name":"Ada"}'
# {"user":{"id":1,"name":"Ada"}}

curl "$URL/objects/team-a/users"
# {"users":[{"id":1,"name":"Ada"}]}

curl "$URL/objects/team-b/users"
# {"users":[]}
```

## Deploy

Configure Cloudflare credentials if needed, then deploy:

```sh
pnpm exec alchemy profile edit --add Cloudflare
pnpm deploy
```

Keep `.alchemy` for subsequent deployments and cleanup.

## Migrations

The example already includes `drizzle/20260919000000_create_users/migration.sql`:

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);
```

`src/Users.ts` captures the SQL during construction and applies it when each object activates:

```ts
Effect.gen(function* () {
  const migrations = yield* Cloudflare.SqlMigrations("./drizzle");

  return Effect.gen(function* () {
    const db = yield* Drizzle.DurableObject({ migrations, relations });
    return { listUsers: () => db.select().from(users) };
  });
});
```

## Schema changes

Add new SQL files with your schema changes; keep applied files unchanged. Restart `pnpm dev` after SQL edits.

```sh
git add src/schema.ts drizzle
git commit -m "Add schema migration"
pnpm deploy
```

## Custom history table

```ts
const migrations = yield* Cloudflare.SqlMigrations({
  dir: "./drizzle",
  table: "app_migrations", // default: __alchemy_migrations
});
```

## Without Drizzle

In the inner instance Effect:

```ts
yield* migrations.apply().pipe(Effect.orDie);
```

See the [migration guide](https://alchemy.run/sql/drizzle/migrations#durable-object-migrations) for drizzle-kit setup, rollback behavior, and existing migration history.

## Integration test

Uses real Cloudflare resources and destroys the test deployment afterward.

```sh
pnpm test
```

## Clean up

Deletes the Worker and all Durable Object data; keeps the SQL files in Git.

```sh
pnpm destroy
```
