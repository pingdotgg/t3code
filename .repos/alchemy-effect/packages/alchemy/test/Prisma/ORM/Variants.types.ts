import type * as Effect from "effect/Effect";
import type { ClientError, PostgresDatabase } from "@/Prisma/ORM/Postgres.ts";
import type { Contract } from "./fixtures/variants/generated/contract.d.ts";

export function variantTypes(
  db: PostgresDatabase<Contract, "connection-error", "connection-service">,
) {
  const bugs = db.orm.public.Task.variant("Bug");
  const rows: Effect.Effect<
    Array<{
      id: number;
      title: string;
      type: "bug";
      severity: string;
      assigneeId: number | null;
    }>,
    ClientError | "connection-error",
    "connection-service"
  > = bugs.all();
  bugs.where((bug) => bug.severity.eq("critical"));
  bugs.orderBy((bug) => bug.severity.asc());
  // @ts-expect-error another variant's fields are unavailable
  bugs.where((bug) => bug.priority.gt(1));
  // @ts-expect-error variant names must exist on the base model
  db.orm.public.Task.variant("Missing");
  const included: Effect.Effect<
    Array<{
      type: "bug";
      assignee: { id: number; name: string } | null;
    }>,
    ClientError | "connection-error",
    "connection-service"
  > = bugs.include("assignee").all();
  const projected = bugs
    .include("assignee", (assignee) => assignee.select("name"))
    .select("id", "title")
    .first();
  type Projected = NonNullable<Effect.Success<typeof projected>>;
  const check = (row: Projected) => {
    const assignee: { name: string } | null = row.assignee;
    // @ts-expect-error scalar variant fields are absent after select
    row.severity;
    // @ts-expect-error only selected base fields remain
    row.type;
    return assignee;
  };
  const feature = db.orm.public.Task.variant("Feature");
  // @ts-expect-error this relation belongs only to Bug
  feature.include("assignee");
  return { rows, included, projected, check };
}
