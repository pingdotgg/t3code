import * as DynamoDB from "@alchemy.run/aws/DynamoDB";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Journal } from "../../../../Workflows/conformance/journal.ts";

/** Every run's journal: one item per run, its entries in order. */
export const JournalTable = DynamoDB.Table("WorkflowJournal", {
  partitionKey: "id",
  attributes: { id: "S" },
});

/** The conformance journal over `JournalTable`, for the host and the caller. */
export const JournalLive = Layer.effect(
  Journal,
  Effect.gen(function* () {
    const table = yield* JournalTable;
    const updateItem = yield* DynamoDB.UpdateItem(table);
    const getItem = yield* DynamoDB.GetItem(table);
    return {
      append: (id, entry) =>
        updateItem({
          Key: { id: { S: id } },
          UpdateExpression: "SET entries = list_append(if_not_exists(entries, :none), :entry)",
          ExpressionAttributeValues: { ":none": { L: [] }, ":entry": { L: [{ S: entry }] } },
        }).pipe(Effect.asVoid, Effect.orDie),
      list: (id) =>
        getItem({ Key: { id: { S: id } }, ConsistentRead: true }).pipe(
          Effect.map(({ Item }) => (Item?.entries?.L ?? []).map((entry) => entry.S ?? "")),
          Effect.orDie,
        ),
    };
  }),
).pipe(Layer.provide(Layer.mergeAll(DynamoDB.UpdateItemHttp, DynamoDB.GetItemHttp)));
