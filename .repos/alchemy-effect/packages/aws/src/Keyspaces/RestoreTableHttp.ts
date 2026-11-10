import * as keyspaces from "@distilled.cloud/aws/keyspaces";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Keyspace } from "./Keyspace.ts";
import { RestoreTable, type RestoreTableRequest } from "./RestoreTable.ts";
import type { Table } from "./Table.ts";

/**
 * HTTP implementation of {@link RestoreTable}: grants `cassandra:Select` on
 * the source table plus `cassandra:Restore` (and the `Create`/`TagResource`
 * actions the restore performs) on the target keyspace and its tables, and
 * calls the Keyspaces HTTP API with the function's IAM credentials.
 */
export const RestoreTableHttp = Layer.effect(
  RestoreTable,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const restoreTable = yield* AWSBindings.withCredentials(keyspaces.restoreTable);

    return Effect.fn(function* <From extends Table, To extends Keyspace>(
      source: From,
      targetKeyspace: To,
    ) {
      const SourceKeyspaceName = yield* source.keyspaceName;
      const SourceTableName = yield* source.tableName;
      const TargetKeyspaceName = yield* targetKeyspace.keyspaceName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Keyspaces.RestoreTable(${source}, ${targetKeyspace})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["cassandra:Select"],
              Resource: [source.tableArn],
            },
            {
              // The keyspace ARN ends with a trailing slash
              // (`.../keyspace/name/`), so its tables match `table/*`.
              Effect: "Allow",
              Action: ["cassandra:Restore", "cassandra:Create", "cassandra:TagResource"],
              Resource: [
                targetKeyspace.keyspaceArn,
                Output.interpolate`${targetKeyspace.keyspaceArn}table/*`,
              ],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Keyspaces.RestoreTable(${source.LogicalId})`)(function* (
        request: RestoreTableRequest,
      ) {
        const sourceKeyspaceName = yield* SourceKeyspaceName;
        const sourceTableName = yield* SourceTableName;
        const targetKeyspaceName = yield* TargetKeyspaceName;
        return yield* restoreTable({
          ...request,
          sourceKeyspaceName,
          sourceTableName,
          targetKeyspaceName,
        });
      });
    });
  }),
);
