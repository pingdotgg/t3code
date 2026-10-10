import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Database } from "./Database.ts";
import { GetDdl, type GetDdlRequest } from "./GetDdl.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor } from "../HttpBinding.ts";

/**
 * HTTP implementation of {@link GetDdl}.
 *
 * @layer
 * @provides GCP.Spanner.GetDdl
 */
export const GetDdlHttp = Layer.effect(
  GetDdl,
  Effect.gen(function* () {
    const getDdlProjectsInstancesDatabases =
      yield* spanner.getDdlProjectsInstancesDatabases;
    return Effect.fn(function* (database: Database) {
      yield* bindGcpHost({
        tag: "GCP.Spanner.GetDdl",
        resource: database,
        iam: [
          grantFor(
            { role: "roles/spanner.databaseReader", on: "spanner.database" },
            database.name,
          ),
        ],
      });
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
