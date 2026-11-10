import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { regionFromArn } from "../Lambda/BindingHttp.ts";
import type { Bucket } from "../S3/Bucket.ts";
import { GrantTables } from "./BindingHttp.ts";
import {
  ExportTableToPointInTime,
  type ExportTableToPointInTimeRequest,
} from "./ExportTableToPointInTime.ts";
import type { Table } from "./Table.ts";

export const ExportTableToPointInTimeHttp = Layer.effect(
  ExportTableToPointInTime,
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
    return Effect.fn(function* <T extends Table, B extends Bucket>(table: T, bucket: B) {
      const TableArn = yield* table.tableArn;
      const S3Bucket = yield* bucket.bucketName;
      yield* grantTables(
        `AWS.DynamoDB.ExportTableToPointInTime(${table.LogicalId}, ${bucket.LogicalId})`,
        () => [
          {
            Effect: "Allow",
            Action: ["dynamodb:ExportTableToPointInTime"],
            Resource: [table.tableArn],
          },
          {
            Effect: "Allow",
            Action: ["s3:AbortMultipartUpload", "s3:PutObject", "s3:PutObjectAcl"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
        ],
      );
      // The export runs in the table's region; the bucket may be elsewhere.
      const exportTableToPointInTime = yield* AWSBindings.withCredentials(
        DynamoDB.exportTableToPointInTime,
        Effect.succeed(Effect.map(TableArn, regionFromArn)),
      );
      return Effect.fn(
        `AWS.DynamoDB.ExportTableToPointInTime(${table.LogicalId}, ${bucket.LogicalId})`,
      )(function* (request?: ExportTableToPointInTimeRequest) {
        return yield* exportTableToPointInTime({
          ...request,
          TableArn: yield* TableArn,
          S3Bucket: yield* S3Bucket,
        });
      });
    });
  }),
);
