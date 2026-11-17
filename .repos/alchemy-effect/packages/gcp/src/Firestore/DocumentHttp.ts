import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";
import type { Database } from "./Database.ts";

/**
 * Shared HTTP scaffolding for Firestore document bindings.
 * NOT exported from index.ts.
 */
export const makeDocumentHttpBinding = <I extends { name: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (database: Database) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${database})`({
          iam: [grantFor(options.iam, database.name)],
        });
      }
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
