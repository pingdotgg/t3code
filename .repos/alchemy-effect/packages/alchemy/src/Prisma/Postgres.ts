import { Database } from "./Database.ts";

/**
 * Product-shaped convenience alias for {@link Database}.
 *
 * `Prisma.Postgres(...)` and `Prisma.Database(...)` use the same underlying
 * Prisma Postgres resource provider. Prefer `Postgres` when you want the code
 * to read like the Prisma product name, and `Database` when you want to mirror
 * the Management API route names. Like `Database`, this standalone resource
 * cannot be the project's default database; use `Prisma.Project` to own the
 * default.
 *
 * **Example:** Example
 * ```typescript
 * const project = yield* Prisma.Project("app", { createDatabase: false });
 * const postgres = yield* Prisma.Postgres("db", {
 *   project,
 *   region: "us-east-1",
 * });
 * ```
 *
 * @resource
 */
export const Postgres = Database;
export type { DatabaseProps as PostgresProps } from "./Database.ts";
