import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Database } from "./Database.ts";
import { GetDdl, type GetDdlRequest } from "./GetDdl.ts";

/**
 * HTTP implementation of {@link GetDdl}.
 *
 * @layer
 * @provides GCP.Spanner.GetDdl
 */
export const GetDdlHttp = Layer.effect(
  GetDdl,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const getDdlProjectsInstancesDatabases = yield* GCPBindings.withCredentials(
      spanner.getDdlProjectsInstancesDatabases,
    );
    return Effect.fn(function* (database: Database) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.Spanner.GetDdl(${database})`({
          iam: [
            grantFor(
              { role: "roles/spanner.databaseReader", on: "spanner.database" },
              database.name,
            ),
          ],
        });
      }
      const name = yield* database.name;
      return Effect.fn(`GCP.Spanner.GetDdl(${database.LogicalId})`)(function* (
        request?: GetDdlRequest,
      ) {
        return yield* getDdlProjectsInstancesDatabases({
          ...request,
          database: yield* name,
        });
      });
    });
  }),
);
