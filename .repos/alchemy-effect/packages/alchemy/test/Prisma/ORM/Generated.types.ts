import { makeSchemas } from "@/Prisma/ORM/Schema.ts";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type * as Schema from "effect/Schema";
import type { PostgresDatabase } from "@/Prisma/ORM/Postgres.ts";
import type { Contract } from "./fixtures/psl/generated/contract.js";
import { makeDatabase } from "./fixtures/psl/generated/client.ts";
import { schemas } from "./fixtures/psl/generated/schemas.ts";
import { contract } from "./fixtures/client/contract.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
const authored = makeSchemas(contract);
export type AuthoredRow = Assert<
  Equal<
    typeof authored.public.User.Type,
    { id: number; email: string; name: string | null }
  >
>;
export type GeneratedId = Assert<
  Equal<typeof schemas.public.User.Type.id, number>
>;
export type GeneratedName = Assert<
  Equal<typeof schemas.public.User.Type.name, string | null>
>;

export function inferredChannels<E, R>(
  connection: Effect.Effect<Redacted.Redacted<string>, E, R>,
) {
  const result: Effect.Effect<PostgresDatabase<Contract, E, R>> =
    makeDatabase(connection);
  return result;
}

export function generatedQueries(db: PostgresDatabase<Contract>) {
  db.orm.public.User.where({ id: 1 }).select("id", "email").all();
  db.orm.public.User.where({ email: "a@example.com" }).include("posts").first();
  // @ts-expect-error generated contracts reject unknown fields
  db.orm.public.User.where({ missing: true });
  // @ts-expect-error generated integer identifiers reject strings
  db.orm.public.User.where({ id: "wrong" });
  // @ts-expect-error generated selection is model-specific
  db.orm.public.User.select("title");
  // @ts-expect-error generated row schemas keep nullable fields required
  const invalid: Schema.Schema.Type<typeof schemas.public.User> = {
    id: 1,
    email: "a@example.com",
  };
  return invalid;
}
