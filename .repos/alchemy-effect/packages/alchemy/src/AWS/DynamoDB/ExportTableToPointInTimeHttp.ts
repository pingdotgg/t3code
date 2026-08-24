import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Bucket } from "../S3/Bucket.ts";
import {
  ExportTableToPointInTime,
  type ExportTableToPointInTimeRequest,
} from "./ExportTableToPointInTime.ts";
import type { Table } from "./Table.ts";

export const ExportTableToPointInTimeHttp = Layer.effect(
  ExportTableToPointInTime,
  Effect.gen(function* () {
    const exportTableToPointInTime = yield* DynamoDB.exportTableToPointInTime;

    return Effect.fn(function* <T extends Table, B extends Bucket>(
      table: T,
      bucket: B,
    ) {
      const TableArn = yield* table.tableArn;
      const S3Bucket = yield* bucket.bucketName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.ExportTableToPointInTime(${table}, ${bucket}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["dynamodb:ExportTableToPointInTime"],
                  Resource: [table.tableArn],
                },
                {
                  Effect: "Allow",
                  Action: [
                    "s3:AbortMultipartUpload",
                    "s3:PutObject",
                    "s3:PutObjectAcl",
                  ],
                  Resource: [Output.interpolate`${bucket.bucketArn}/*`],
                },
              ],
            },
          );
        }
      }
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
