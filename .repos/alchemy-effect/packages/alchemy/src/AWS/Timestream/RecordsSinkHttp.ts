import type * as TSW from "@distilled.cloud/aws/timestream-write";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { makeBatchedSink } from "../internal/BatchedSink.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  RecordsSink,
  type RecordsSinkProps,
  type RecordsSinkRecord,
} from "./RecordsSink.ts";
import type { Table } from "./Table.ts";
import { WriteRecords } from "./WriteRecords.ts";

/**
 * Normalized `WriteRecords` outcome: which positions of the submitted batch
 * Timestream permanently rejected. A fully-ingested call has no rejections.
 */
interface WriteOutcome {
  readonly rejectedIndices: ReadonlySet<number>;
}

const noRejections: WriteOutcome = { rejectedIndices: new Set() };

type WriteSendError = Exclude<
  TSW.WriteRecordsError | TSW.DescribeEndpointsError,
  TSW.RejectedRecordsException
>;

export const RecordsSinkHttp = Layer.effect(
  RecordsSink,
  Effect.gen(function* () {
    const writeRecords = yield* WriteRecords;

    return Effect.fn(function* (table: Table, props?: RecordsSinkProps) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Timestream.RecordsSink(${table}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["timestream:WriteRecords"],
                  Resource: [Output.interpolate`${table.tableArn}`],
                },
                // Timestream requires endpoint discovery; the ingest endpoint
                // is resolved at runtime via DescribeEndpoints, which is not
                // scoped to a resource.
                {
                  Effect: "Allow",
                  Action: ["timestream:DescribeEndpoints"],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      const write = yield* writeRecords(table);
      const commonAttributes = props?.commonAttributes;
      return makeBatchedSink<RecordsSinkRecord, WriteOutcome, WriteSendError>({
        maxRecords: 100,
        send: (batch) =>
          write({
            Records: [...batch],
            ...(commonAttributes === undefined
              ? {}
              : { CommonAttributes: commonAttributes }),
          }).pipe(
            Effect.map(() => noRejections),
            // Timestream ingests the valid subset and reports invalid records
            // positionally via RejectedRecordsException. Rejections are
            // permanent (schema conflicts, out-of-retention timestamps,
            // version conflicts) — drop them, never retry.
            Effect.catchTag("RejectedRecordsException", (error) =>
              Effect.succeed<WriteOutcome>({
                rejectedIndices: new Set(
                  (error.RejectedRecords ?? []).flatMap(
                    (rejected: TSW.RejectedRecord) =>
                      rejected.RecordIndex === undefined
                        ? []
                        : [rejected.RecordIndex],
                  ),
                ),
              }),
            ),
          ),
        rejected: (out, batch) =>
          out.rejectedIndices.size === 0
            ? []
            : batch.filter((_, index) => out.rejectedIndices.has(index)),
      });
    });
  }),
);
