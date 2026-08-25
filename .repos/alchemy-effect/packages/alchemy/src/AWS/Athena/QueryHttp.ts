import * as athena from "@distilled.cloud/aws/athena";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Bucket } from "../S3/Bucket.ts";
import type { Output as OutputType } from "../../Output.ts";
import {
  AthenaQueryFailed,
  Query,
  type QueryResult,
  type RunQueryRequest,
} from "./Query.ts";
import type { WorkGroup } from "./WorkGroup.ts";

// The workgroup ARN is `arn:aws:athena:{region}:{account}:workgroup/{name}` —
// the Glue Data Catalog ARNs share that partition/region/account.
const glueBase = (workGroupArn: OutputType<string>) =>
  workGroupArn.pipe(
    Output.map((arn) => {
      const [, partition, , region, account] = arn.split(":");
      return `arn:${partition}:glue:${region}:${account}`;
    }),
  );
const glueCatalogArn = (workGroupArn: OutputType<string>) =>
  glueBase(workGroupArn).pipe(Output.map((base) => `${base}:catalog`));
const glueDatabaseArn = (workGroupArn: OutputType<string>) =>
  glueBase(workGroupArn).pipe(Output.map((base) => `${base}:database/*`));
const glueTableArn = (workGroupArn: OutputType<string>) =>
  glueBase(workGroupArn).pipe(Output.map((base) => `${base}:table/*/*`));

export const QueryHttp = Layer.effect(
  Query,
  Effect.gen(function* () {
    const startQueryExecution = yield* athena.startQueryExecution;
    const getQueryExecution = yield* athena.getQueryExecution;
    const getQueryResults = yield* athena.getQueryResults;

    return Effect.fn(function* (workGroup: WorkGroup, resultsBucket: Bucket) {
      const WorkGroupName = yield* workGroup.workGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Athena.Query(${workGroup}, ${resultsBucket}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    "athena:StartQueryExecution",
                    "athena:GetQueryExecution",
                    "athena:GetQueryResults",
                    "athena:StopQueryExecution",
                  ],
                  Resource: [workGroup.workGroupArn],
                },
                {
                  Effect: "Allow",
                  Action: ["s3:GetBucketLocation", "s3:ListBucket"],
                  Resource: [resultsBucket.bucketArn],
                },
                {
                  Effect: "Allow",
                  Action: [
                    "s3:GetObject",
                    "s3:PutObject",
                    "s3:AbortMultipartUpload",
                  ],
                  Resource: [Output.interpolate`${resultsBucket.bucketArn}/*`],
                },
                {
                  // Athena resolves table metadata through the Glue Data
                  // Catalog on the caller's behalf — reads are required for any
                  // query over a Glue-backed table. Scoped to the workgroup's
                  // account/region catalog (derived from its ARN).
                  Effect: "Allow",
                  Action: [
                    "glue:GetDatabase",
                    "glue:GetDatabases",
                    "glue:GetTable",
                    "glue:GetTables",
                    "glue:GetPartition",
                    "glue:GetPartitions",
                  ],
                  Resource: [
                    glueCatalogArn(workGroup.workGroupArn),
                    glueDatabaseArn(workGroup.workGroupArn),
                    glueTableArn(workGroup.workGroupArn),
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Athena.Query(${workGroup.LogicalId})`)(function* (
        request: RunQueryRequest,
      ) {
        const workGroupName = yield* WorkGroupName;
        const started = yield* startQueryExecution({
          ...request,
          WorkGroup: workGroupName,
        });
        const queryExecutionId = started.QueryExecutionId!;

        // Poll GetQueryExecution until terminal — bounded to ~90s so a hung
        // query fails fast instead of hitting the caller's timeout.
        const exec = yield* getQueryExecution({
          QueryExecutionId: queryExecutionId,
        }).pipe(
          Effect.map((r) => r.QueryExecution),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (qe) => {
              const s = qe?.Status?.State;
              return s === "SUCCEEDED" || s === "FAILED" || s === "CANCELLED";
            },
            times: 90,
          }),
        );

        const state = exec?.Status?.State ?? "FAILED";
        const reason = exec?.Status?.StateChangeReason;
        if (state !== "SUCCEEDED") {
          return yield* Effect.fail(
            new AthenaQueryFailed({ queryExecutionId, state, reason }),
          );
        }

        const results = yield* getQueryResults({
          QueryExecutionId: queryExecutionId,
        });
        const columns = (
          results.ResultSet?.ResultSetMetadata?.ColumnInfo ?? []
        ).map((c) => c.Name);
        const rows = (results.ResultSet?.Rows ?? []).map((row) =>
          (row.Data ?? []).map((d) => d.VarCharValue ?? ""),
        );
        return {
          queryExecutionId,
          state,
          stateChangeReason: reason,
          columns,
          rows,
        } satisfies QueryResult;
      });
    });
  }),
);
