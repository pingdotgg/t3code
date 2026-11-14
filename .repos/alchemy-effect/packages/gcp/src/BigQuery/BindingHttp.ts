import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";
import type { Table } from "./Table.ts";

/**
 * Shared HTTP scaffolding for BigQuery table bindings.
 * NOT exported from index.ts.
 */
export const makeTableHttpBinding = <
  I extends { projectId: string; datasetId: string; tableId: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (table: Table) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${table})`({
          iam: [grantFor(options.iam, table.name)],
        });
      }
      const project = yield* table.project;
      const datasetId = yield* table.datasetId;
      const tableId = yield* table.tableId;
      return Effect.fn(`${options.tag}(${table.LogicalId})`)(function* (
        request?: Omit<I, "projectId" | "datasetId" | "tableId">,
      ) {
        return yield* run({
          ...request,
          projectId: yield* project,
          datasetId: yield* datasetId,
          tableId: yield* tableId,
        } as I);
      });
    });
  });
