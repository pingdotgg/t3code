import {
  defineContract,
  enumType,
  field,
  member,
  model,
} from "@/Prisma/ORM/index.ts";
import type { PostgresDatabase } from "@/Prisma/ORM/Postgres.ts";
import type { ExtractTypeMapsFromContract } from "@prisma/orm-postgres/family-contract/types";
import type { PostgresAggregateTypes } from "@/Prisma/ORM/PostgresAggregateTypes.ts";
import type { AggregateTypes } from "./fixtures/client/generated/contract.d.ts";
import type * as Effect from "effect/Effect";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Normalized<T> = T extends object
  ? { [K in keyof T]: Normalized<T[K]> }
  : T;
export type AggregateParity = Assert<
  Equal<Normalized<PostgresAggregateTypes>, Normalized<AggregateTypes>>
>;

const contract = defineContract(
  { namespaces: ["auth"] },
  ({ field, model }) => ({
    models: {
      Account: model("Account", {
        namespace: "auth",
        fields: {
          id: field.int().id().defaultSql("1").sql({ column: "account_id" }),
          name: field.text(),
          tags: field.text().many(),
          nullableTags: field.text().many().optional(),
          nickname: field.text().optional(),
          mapped: field.text().column("mapped_name"),
        },
      }).sql({ table: "account" }),
    },
  }),
);
type Maps = ExtractTypeMapsFromContract<typeof contract>;
export type Fields = Assert<
  Equal<
    Maps["fieldOutputTypes"]["auth"]["Account"],
    {
      readonly id: number;
      readonly name: string;
      readonly tags: readonly string[];
      readonly nullableTags: readonly string[] | null;
      readonly nickname: string | null;
      readonly mapped: string;
    }
  >
>;
export type MappedColumn = Assert<
  Equal<Maps["storageColumnTypes"]["auth"]["account"]["mapped_name"], string>
>;
export type ScalarColumn = Assert<
  Equal<
    "many" extends keyof typeof contract.storage.namespaces.auth.entries.table.account.columns.name
      ? true
      : false,
    false
  >
>;
export type ListColumn = Assert<
  Equal<
    typeof contract.storage.namespaces.auth.entries.table.account.columns.tags.many,
    true
  >
>;

const Status = enumType(
  "Status",
  { codecId: "pg/text@1", nativeType: "text" },
  member("Active", "active"),
  member("Inactive", "inactive"),
);
const direct = defineContract({
  models: {
    Record: model("Record", {
      fields: {
        id: field.column({ codecId: "pg/int4@1", nativeType: "int4" }).id(),
        values: field.column({ codecId: "pg/jsonb@1", nativeType: "jsonb" }),
        status: field.namedType(Status),
      },
    }),
  },
  enums: { Status },
});
type DirectMaps = ExtractTypeMapsFromContract<typeof direct>;
export type NativeArray = Assert<
  Equal<
    DirectMaps["fieldOutputTypes"]["public"]["Record"]["values"],
    import("@prisma/orm-postgres/target/codec-types").CodecTypes["pg/jsonb@1"]["output"]
  >
>;
export type EnumOutput = Assert<
  Equal<
    DirectMaps["fieldOutputTypes"]["public"]["Record"]["status"],
    "active" | "inactive"
  >
>;
// @ts-expect-error native enum defaults remain constrained to their declared values
field.namedType(Status).default("missing");

export function contractTypes(db: PostgresDatabase<typeof contract>): void {
  // @ts-expect-error global naming is rejected until its erased scaffold metadata can be retained
  defineContract({ naming: { tables: "snake_case" } }, () => ({ models: {} }));
  db.orm.auth.Account.create({ name: "A", tags: [], mapped: "M" });
  // @ts-expect-error required fields remain required even when another field has a default
  db.orm.auth.Account.create({ tags: [], mapped: "M" });
  // @ts-expect-error scalar filters reject arrays
  db.orm.auth.Account.where({ name: ["A"] });
  // @ts-expect-error numeric fields reject strings
  db.orm.auth.Account.where({ id: "1" });
  // @ts-expect-error custom namespace models are not also in public
  db.orm.public.Account;
  const count: Effect.Effect<{ total: number }, unknown> =
    db.orm.auth.Account.aggregate((aggregate) => ({
      total: aggregate.count(),
    }));
  void count;
}
