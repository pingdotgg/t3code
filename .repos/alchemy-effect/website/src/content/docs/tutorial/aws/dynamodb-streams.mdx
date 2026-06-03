---
title: Process DynamoDB Streams
description: Enable a DynamoDB Stream on your table and consume change records as a typed Effect Stream from the same Lambda.
sidebar:
  order: 5
---

The DynamoDB table from the previous part stores records, but
writes happen in the dark — there's no way for downstream systems
to react. **DynamoDB Streams** fix that: every change to the
table emits a change record (insert / modify / remove) you can
stream into a Lambda. In Alchemy this is one helper call.

## Subscribe to the stream

Start with the smallest possible subscription: log just the
event name (`INSERT` / `MODIFY` / `REMOVE`) for each change.
Add it alongside the existing bindings:

```diff lang="typescript"
// src/api.ts
import * as AWS from "alchemy/AWS";
import * as DynamoDB from "alchemy/AWS/DynamoDB";
+import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
+import * as Stream from "effect/Stream";
// ...

const table = yield* DynamoDB.Table("Items", { /* ... */ });
const putItem = yield* DynamoDB.PutItem.bind(table);
const getItem = yield* DynamoDB.GetItem.bind(table);

+yield* DynamoDB.stream(table).process((stream) =>
+  stream.pipe(
+    Stream.runForEach((record) =>
+      Console.log(`${record.eventName}: ${record.dynamodb.Keys?.id?.S}`),
+    ),
+  ),
+);
```

That single `.process(...)` call enables a stream on the table,
creates a Lambda `EventSourceMapping` that polls it, and adds
the IAM grants for `dynamodb:GetRecords`, `GetShardIterator`,
`DescribeStream`, and `ListStreams` — all from the call site.

## Pick the view type

By default the stream emits keys only. Most handlers want the
full row before and after the change — set `streamViewType` to
`NEW_AND_OLD_IMAGES`:

```diff lang="typescript"
-yield* DynamoDB.stream(table).process((stream) =>
+yield* DynamoDB.stream(table, {
+  streamViewType: "NEW_AND_OLD_IMAGES",
+}).process((stream) =>
  stream.pipe(/* ... */),
);
```

The other options (`KEYS_ONLY`, `NEW_IMAGE`, `OLD_IMAGE`) trade
payload size for less detail — pick the smallest one your
handler actually needs.

## Control where consumption starts

`startingPosition: "LATEST"` is the default and ignores history;
the consumer only sees records that arrive after the
event-source mapping is enabled. Switch to `"TRIM_HORIZON"` to
replay everything currently in the stream's 24-hour retention
window:

```diff lang="typescript"
yield* DynamoDB.stream(table, {
  streamViewType: "NEW_AND_OLD_IMAGES",
+  startingPosition: "TRIM_HORIZON",
+  batchSize: 10,
}).process((stream) =>
  stream.pipe(/* ... */),
);
```

`batchSize` caps the number of records the function sees per
invocation. Larger batches are more efficient; smaller batches
fail in smaller blast radii.

## Type the row payload

DynamoDB stream records use the same attribute-value shape as
`GetItem`/`PutItem`. Describe the row inline as a generic on
`.process` and TypeScript will help you destructure
`NewImage`/`OldImage`:

```diff lang="typescript"
yield* DynamoDB.stream(table, {
  streamViewType: "NEW_AND_OLD_IMAGES",
  startingPosition: "TRIM_HORIZON",
  batchSize: 10,
-}).process((stream) =>
+}).process<{ id: { S: string }; content: { S: string } }>((stream) =>
  stream.pipe(
    Stream.runForEach((record) =>
-      Console.log(`${record.eventName}: ${record.dynamodb.Keys?.id?.S}`),
+      Console.log(
+        `${record.eventName}: ${record.dynamodb.Keys?.id?.S} -> ` +
+          `${record.dynamodb.NewImage?.content.S ?? "(deleted)"}`,
+      ),
    ),
  ),
);
```

## Provide the runtime layer

The Lambda-specific implementation of `TableEventSource` is in
`Lambda.TableEventSource`. Add it to the merged layer:

```diff lang="typescript"
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      AWS.Lambda.BucketEventSource,
+      AWS.Lambda.TableEventSource,
      DynamoDB.GetItemLive,
      DynamoDB.PutItemLive,
      S3.PutObjectLive,
      S3.GetObjectLive,
    ),
  ),
),
```

`TableEventSource` is the binding that mutates the table's stream
configuration during deploy and creates the event source mapping.
You don't have to think about either — they're both side effects
of `.process(...)`.

## Deploy

```sh
bun alchemy deploy
```

Alchemy enables the stream on the table (takes a few seconds for
the table to settle) then creates the event source mapping. Once
the mapping is `Enabled`, every `PutItem`/`UpdateItem`/`DeleteItem`
shows up in your function's CloudWatch logs.

## Verify

Reuse the `PUT /items/:id` route to publish changes, then tail
the function logs to confirm they arrive:

```sh
bun alchemy logs Api --follow
```

In another terminal:

```sh
curl -X PUT --data 'first' "$URL/items/one"
curl -X PUT --data 'second' "$URL/items/two"
curl -X PUT --data 'updated' "$URL/items/one"
```

You'll see three `MODIFY`/`INSERT` log lines stream past — one
per write. Stream records typically arrive within 1–2 seconds of
the originating change.

## Why a Stream instead of a callback?

The `process(handler)` signature mirrors the S3 events helper for
a reason — once your event source is a typed `Stream<Record>`,
back-pressure, batching, retries, parallel side effects, and
in-order processing are all just composition:

```typescript
stream.pipe(
  Stream.groupedWithin(50, "5 seconds"),
  Stream.mapEffect((batch) => writeToWarehouse(batch), { concurrency: 4 }),
  Stream.runDrain,
);
```

The same operators work for DynamoDB Streams, S3 events, SQS
messages, and Kinesis records — the only thing that changes is
the element type.

Next we'll add an [SQS Queue](/tutorial/aws/sqs) so the Lambda
can fan changes (or anything else) out to a different consumer
process and pick them up downstream.
