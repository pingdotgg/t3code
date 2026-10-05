import * as Effect from "effect/Effect";
import type { Database } from "./Database.ts";
import { bindGcpHost } from "../Host.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Firestore document bindings.
 * NOT exported from index.ts.
 */
export const makeDocumentHttpBinding = <
  I extends { name: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (database: Database) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: database,
        iam: [grantFor(options.iam, database.name)],
      });
      const name = yield* database.name;
      return Effect.fn(`${options.tag}(${database.LogicalId})`)(function* (
        request: Omit<I, "name"> & { documentPath: string },
      ) {
        const documentPath = request.documentPath;
        const relative = documentPath.replace(/^\/+/, "");
        const databaseName = yield* name;
        const rest: Omit<I, "name"> = request;
        return yield* run({
          ...rest,
          name: `${databaseName}/documents/${relative}`,
        } as I);
      });
    });
  });
