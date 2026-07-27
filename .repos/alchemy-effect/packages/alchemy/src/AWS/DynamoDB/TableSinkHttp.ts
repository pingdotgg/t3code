import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { makeBatchedSink } from "../internal/BatchedSink.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { BatchWriteItem } from "./BatchWriteItem.ts";
import type { Table } from "./Table.ts";
import { TableSink, type TableSinkEntry } from "./TableSink.ts";

const encoder = new TextEncoder();

/**
 * Map the `UnprocessedItems` echoed by `BatchWriteItem` back onto the
 * original batch entries, preserving input order. The response is
 * deserialized (identity is lost), so entries are matched by canonical JSON
 * as a multiset — DynamoDB rejects batches containing duplicate keys, so a
 * multiset over serialized entries is unambiguous in practice. If any echoed
 * entry fails to match (e.g. key-order drift in the echo), fall back to the
 * echoed entries verbatim so nothing is ever silently dropped from the retry.
 */
const selectUnprocessed = (
  unprocessed:
    | { [key: string]: DynamoDB.WriteRequest[] | undefined }
    | undefined,
  batch: readonly TableSinkEntry[],
): readonly TableSinkEntry[] => {
  // The sink writes a single table, so at most one key is present.
  const echoed = Object.values(unprocessed ?? {}).flatMap(
    (requests) => requests ?? [],
  );
  if (echoed.length === 0) {
    return [];
  }
  const remaining = new Map<string, number>();
  for (const request of echoed) {
    const key = JSON.stringify(request);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const matched = batch.filter((entry) => {
    const key = JSON.stringify(entry);
    const count = remaining.get(key) ?? 0;
    if (count === 0) {
      return false;
    }
    remaining.set(key, count - 1);
    return true;
  });
  return matched.length === echoed.length ? matched : echoed;
};

export const TableSinkHttp = Layer.effect(
  TableSink,
  Effect.gen(function* () {
    const batchWriteItem = yield* BatchWriteItem;

    return Effect.fn(function* (table: Table) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.TableSink(${table}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["dynamodb:BatchWriteItem"],
                Resource: [table.tableArn],
              },
            ],
          });
        }
      }
      const write = yield* batchWriteItem(table);
      return makeBatchedSink<
        TableSinkEntry,
        DynamoDB.BatchWriteItemOutput,
        DynamoDB.BatchWriteItemError
      >({
        maxRecords: 25,
        maxBytes: 16_777_216,
        sizeOf: (request) => encoder.encode(JSON.stringify(request)).length,
        send: (batch) =>
          write({ RequestItems: { [table.LogicalId]: [...batch] } }),
        // UnprocessedItems are transient (throttling, internal errors) —
        // re-submit them on the bounded schedule.
        unprocessed: (out, batch) =>
          selectUnprocessed(out.UnprocessedItems, batch),
      });
    });
  }),
);
