import * as data from "@distilled.cloud/aws/redshift-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Workgroup } from "../RedshiftServerless/Workgroup.ts";
import {
  RedshiftStatementFailed,
  Statements,
  type BatchExecuteStatementRequest,
  type DescribeTableRequest,
  type ExecuteStatementRequest,
  type ListDatabasesRequest,
  type ListSchemasRequest,
  type ListStatementsRequest,
  type ListTablesRequest,
  type StatementsClient,
  type StatementsOptions,
} from "./Statements.ts";

/** Statement statuses that mean the run is over. */
const isTerminal = (status: string | undefined): boolean =>
  status === "FINISHED" || status === "FAILED" || status === "ABORTED";

export const StatementsHttp = Layer.effect(
  Statements,
  Effect.gen(function* () {
    const executeStatement = yield* data.executeStatement;
    const batchExecuteStatement = yield* data.batchExecuteStatement;
    const describeStatement = yield* data.describeStatement;
    const cancelStatement = yield* data.cancelStatement;
    const getStatementResult = yield* data.getStatementResult;
    const getStatementResultV2 = yield* data.getStatementResultV2;
    const describeTableOp = yield* data.describeTable;
    const listDatabasesOp = yield* data.listDatabases;
    const listSchemasOp = yield* data.listSchemas;
    const listTablesOp = yield* data.listTables;
    const listStatementsOp = yield* data.listStatements;

    return Effect.fn(function* (
      workgroup: Workgroup,
      options: StatementsOptions = {},
    ) {
      const workgroupName = yield* workgroup.workgroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.RedshiftData.Statements(${workgroup}))`(
            {
              policyStatements: [
                {
                  // Workgroup-scoped Data API actions (submit statements and
                  // read database metadata through the workgroup).
                  Effect: "Allow",
                  Action: [
                    "redshift-data:ExecuteStatement",
                    "redshift-data:BatchExecuteStatement",
                    "redshift-data:DescribeTable",
                    "redshift-data:ListDatabases",
                    "redshift-data:ListSchemas",
                    "redshift-data:ListTables",
                  ],
                  Resource: [workgroup.workgroupArn],
                },
                {
                  // Statement-scoped actions are authorized per-statement
                  // (owner condition), not by ARN.
                  Effect: "Allow",
                  Action: [
                    "redshift-data:DescribeStatement",
                    "redshift-data:GetStatementResult",
                    "redshift-data:GetStatementResultV2",
                    "redshift-data:CancelStatement",
                    "redshift-data:ListStatements",
                  ],
                  Resource: ["*"],
                },
                {
                  // IAM temporary-credential auth against the serverless
                  // workgroup (used when no SecretArn is supplied).
                  Effect: "Allow",
                  Action: ["redshift-serverless:GetCredentials"],
                  Resource: [workgroup.workgroupArn],
                },
                ...(options.secretArn
                  ? [
                      {
                        Effect: "Allow" as const,
                        Action: [
                          "secretsmanager:GetSecretValue",
                          "secretsmanager:DescribeSecret",
                        ],
                        Resource: [options.secretArn],
                      },
                    ]
                  : []),
              ],
            },
          );
        }
      }

      const database = options.database ?? "dev";

      const execute = Effect.fn(
        `AWS.RedshiftData.Statements.execute(${workgroup.LogicalId})`,
      )(function* (request: ExecuteStatementRequest) {
        return yield* executeStatement({
          ...request,
          WorkgroupName: yield* workgroupName,
          Database: database,
          SecretArn: options.secretArn,
          DbUser: options.dbUser,
        });
      });

      const executeBatch = Effect.fn(
        `AWS.RedshiftData.Statements.executeBatch(${workgroup.LogicalId})`,
      )(function* (request: BatchExecuteStatementRequest) {
        return yield* batchExecuteStatement({
          ...request,
          WorkgroupName: yield* workgroupName,
          Database: database,
          SecretArn: options.secretArn,
          DbUser: options.dbUser,
        });
      });

      const describe = Effect.fn(
        `AWS.RedshiftData.Statements.describe(${workgroup.LogicalId})`,
      )(function* (id: string) {
        return yield* describeStatement({ Id: id });
      });

      const cancel = Effect.fn(
        `AWS.RedshiftData.Statements.cancel(${workgroup.LogicalId})`,
      )(function* (id: string) {
        return yield* cancelStatement({ Id: id });
      });

      const getResult = Effect.fn(
        `AWS.RedshiftData.Statements.getResult(${workgroup.LogicalId})`,
      )(function* (id: string, nextToken?: string) {
        return yield* getStatementResult({ Id: id, NextToken: nextToken });
      });

      const getResultV2 = Effect.fn(
        `AWS.RedshiftData.Statements.getResultV2(${workgroup.LogicalId})`,
      )(function* (id: string, nextToken?: string) {
        return yield* getStatementResultV2({ Id: id, NextToken: nextToken });
      });

      const describeTable = Effect.fn(
        `AWS.RedshiftData.Statements.describeTable(${workgroup.LogicalId})`,
      )(function* (request: DescribeTableRequest) {
        return yield* describeTableOp({
          ...request,
          WorkgroupName: yield* workgroupName,
          Database: database,
          SecretArn: options.secretArn,
          DbUser: options.dbUser,
        });
      });

      const listDatabases = Effect.fn(
        `AWS.RedshiftData.Statements.listDatabases(${workgroup.LogicalId})`,
      )(function* (request: ListDatabasesRequest = {}) {
        return yield* listDatabasesOp({
          ...request,
          WorkgroupName: yield* workgroupName,
          Database: database,
          SecretArn: options.secretArn,
          DbUser: options.dbUser,
        });
      });

      const listSchemas = Effect.fn(
        `AWS.RedshiftData.Statements.listSchemas(${workgroup.LogicalId})`,
      )(function* (request: ListSchemasRequest = {}) {
        return yield* listSchemasOp({
          ...request,
          WorkgroupName: yield* workgroupName,
          Database: database,
          SecretArn: options.secretArn,
          DbUser: options.dbUser,
        });
      });

      const listTables = Effect.fn(
        `AWS.RedshiftData.Statements.listTables(${workgroup.LogicalId})`,
      )(function* (request: ListTablesRequest = {}) {
        return yield* listTablesOp({
          ...request,
          WorkgroupName: yield* workgroupName,
          Database: database,
          SecretArn: options.secretArn,
          DbUser: options.dbUser,
        });
      });

      const listStatements = Effect.fn(
        `AWS.RedshiftData.Statements.listStatements(${workgroup.LogicalId})`,
      )(function* (request: ListStatementsRequest = {}) {
        return yield* listStatementsOp({
          ...request,
          WorkgroupName: yield* workgroupName,
        });
      });

      const query = Effect.fn(
        `AWS.RedshiftData.Statements.query(${workgroup.LogicalId})`,
      )(function* (sql: string, parameters?: data.SqlParameter[]) {
        const submitted = yield* execute({ Sql: sql, Parameters: parameters });
        const id = submitted.Id!;
        // Poll until the statement reaches a terminal status. Redshift
        // Serverless typically finishes simple statements in a few seconds;
        // budget ~2.5 min (30 * 5s).
        const described = yield* describe(id).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (r) => isTerminal(r.Status),
            times: 30,
          }),
        );
        if (described.Status !== "FINISHED") {
          return yield* Effect.fail(
            new RedshiftStatementFailed({
              statementId: id,
              status: described.Status ?? "UNKNOWN",
              error: described.Error,
            }),
          );
        }
        return yield* getResult(id);
      });

      return {
        execute,
        executeBatch,
        describe,
        cancel,
        getResult,
        getResultV2,
        describeTable,
        listDatabases,
        listSchemas,
        listTables,
        listStatements,
        query,
      } satisfies StatementsClient;
    });
  }),
);
