---
title: Stream Records with Kinesis
description: Add a Kinesis Data Stream, publish records from one Lambda, and consume them in order from another — wired through the same Stream-shaped event source.
sidebar:
  order: 7
---

SQS is great for unordered work. **Kinesis Data Streams** are the
right tool when you need **ordered** delivery within a partition,
high throughput, replay from arbitrary points in time, and
multiple independent consumers reading the same records. In this
final part of the AWS track you'll add a Kinesis stream, publish
to it from your producer Lambda, and consume it from a new
worker.

## Add the stream

Lift the Kinesis stream into a shared module the same way you
did with the SQS queue, so both producer and consumer can
import the same handle:

```typescript
// src/stream.ts
import * as Kinesis from "alchemy/AWS/Kinesis";

export const Events = Kinesis.Stream("Events", {
  streamMode: "ON_DEMAND",
});
```

`"ON_DEMAND"` lets AWS auto-scale the shards based on load —
fine for the example. Switch to `"PROVISIONED"` with an explicit
`shardCount` when you know your throughput.

## Bind PutRecord on the producer

```diff lang="typescript"
// src/api.ts
import * as DynamoDB from "alchemy/AWS/DynamoDB";
+import * as Kinesis from "alchemy/AWS/Kinesis";
import * as S3 from "alchemy/AWS/S3";
import * as SQS from "alchemy/AWS/SQS";
import { Jobs } from "./queue.ts";
+import { Events } from "./stream.ts";
// ...

const queue = yield* Jobs;
+const events = yield* Events;
const sendMessage = yield* SQS.SendMessage.bind(queue);
+const putRecord = yield* Kinesis.PutRecord.bind(events);
```

The shape mirrors every other binding you've seen: `bind(stream)`
returns a callable Effect, plus an IAM policy with
`kinesis:PutRecord` scoped to this stream's ARN.

## Publish a record

Use `putRecord` inside the `PUT /items/:id` route — alongside
the SQS publish — to send an ordered audit record for each
write:

```diff lang="typescript"
yield* sendMessage({
  MessageBody: JSON.stringify({ type: "job.created", id, content }),
});
+yield* putRecord({
+  PartitionKey: id,
+  Data: new TextEncoder().encode(
+    JSON.stringify({ type: "job.created", id, content, at: Date.now() }),
+  ),
+});
```

`PartitionKey` controls which shard a record lands in. All
records with the same partition key are delivered in order to
the same consumer instance — the entity id is exactly what you
want here.

`Data` is an arbitrary `Uint8Array`, not a string. JSON-encoded
UTF-8 bytes are the most common payload but you can ship Avro,
protobuf, or raw blobs without changing the binding.

## Provide the runtime layer

```diff lang="typescript"
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      // ... existing layers ...
+      Kinesis.PutRecordLive,
      SQS.SendMessageLive,
    ),
  ),
),
```

## Stand up a consumer Lambda

Create `src/audit.ts` with a bare consumer shell — no event
source yet, just the empty class importing the shared stream
handle:

```typescript
// src/audit.ts
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { Events } from "./stream.ts";

export default class Audit extends AWS.Lambda.Function<Audit>()(
  "Audit",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const events = yield* Events;
    return {};
  }),
) {}
```

## Subscribe to records

`Kinesis.records(stream).process(...)` mirrors the SQS
`messages(...).subscribe(...)` shape from the previous part.
Add the smallest possible subscription — log each record's
partition key:

```diff lang="typescript"
// src/audit.ts
import * as AWS from "alchemy/AWS";
+import * as Kinesis from "alchemy/AWS/Kinesis";
+import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
+import * as Stream from "effect/Stream";
import { Events } from "./stream.ts";

export default class Audit extends AWS.Lambda.Function<Audit>()(
  "Audit",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const events = yield* Events;
+
+    yield* Kinesis.records(events, {
+      startingPosition: "LATEST",
+      batchSize: 100,
+    }).process((stream) =>
+      stream.pipe(
+        Stream.runForEach((record) =>
+          Console.log(`[${record.kinesis.partitionKey}]`),
+        ),
+      ),
+    );

    return {};
  }),
) {}
```

`batchSize: 100` lets Lambda gather up to 100 records per
invocation; the whole batch is delivered as one stream emission
sequence, then the stream completes and Lambda checkpoints.
`startingPosition: "LATEST"` skips history — switch to
`"TRIM_HORIZON"` to replay the 24-hour retention window.

## Decode the binary payload

Kinesis record data arrives base64-encoded inside the Lambda
envelope (an artifact of the event shape, not the stream
itself). Decode it back to bytes and on to a string, and run
the work as an Effect per record:

```diff lang="typescript"
yield* Kinesis.records(events, {
  startingPosition: "LATEST",
  batchSize: 100,
}).process((stream) =>
  stream.pipe(
-    Stream.runForEach((record) =>
-      Console.log(`[${record.kinesis.partitionKey}]`),
-    ),
+    Stream.mapEffect((record) =>
+      Effect.gen(function* () {
+        const text = new TextDecoder().decode(
+          Buffer.from(record.kinesis.data, "base64"),
+        );
+        yield* Console.log(`[${record.kinesis.partitionKey}] ${text}`);
+      }),
+    ),
+    Stream.runDrain,
  ),
);
```

## Provide the runtime layer

`Lambda.StreamEventSource` is the binding that enables the event
source mapping and grants `kinesis:GetRecords`,
`GetShardIterator`, `DescribeStream`, and `ListShards` on the
stream ARN. Provide it at the bottom of the function:

```diff lang="typescript"
    return {};
-  }),
+  }).pipe(Effect.provide(AWS.Lambda.StreamEventSource)),
) {}
```

## Wire the consumer into the Stack

```diff lang="typescript"
// alchemy.run.ts
import Api from "./src/api.ts";
+import Audit from "./src/audit.ts";
import Worker from "./src/worker.ts";

Effect.gen(function* () {
  const api = yield* Api;
  yield* Worker;
+  yield* Audit;
  return { url: api.functionUrl };
}),
```

## Deploy

```sh
bun alchemy deploy
```

Three functions now coexist: `Api` produces records, `Worker`
consumes the SQS queue, and `Audit` consumes the Kinesis stream.
Each one gets a least-privilege policy that names exactly the
resources its `bind`/`subscribe`/`process` calls touched — no
`"*"`, no IAM JSON to maintain.

## Verify

```sh
curl -X PUT --data 'audit me' "$URL/items/k1"
bun alchemy logs Audit --follow
```

You'll see a line like:

```
[k1] {"type":"job.created","id":"k1","content":"audit me","at":1718000000000}
```

Subsequent writes against the same `id` (`k1`) all land in the
same shard and arrive in order at the same `Audit` invocation
context — that's the ordering guarantee Kinesis provides per
partition key.

## Bonus: in-order side effects

Because each batch is delivered as a `Stream`, **per-shard ordering
is preserved end-to-end**. If you need strict ordering for side
effects, drop the concurrency to 1 and let the stream do the work:

```typescript
stream.pipe(
  Stream.mapEffect(
    (record) => persistInOrder(record).pipe(Effect.orDie),
    { concurrency: 1 },
  ),
  Stream.runDrain,
);
```

Or fan out per-partition with `Stream.groupByKey(record => record.kinesis.partitionKey)`
when ordering only matters within a key.

## What you've built

Across the AWS track you've gone from a single Lambda to a small
event-driven system: a public HTTP API backed by S3 blobs and a
DynamoDB table, table change events on a stream, an SQS work
queue, and a high-throughput Kinesis pipeline — all wired through
the same binding pattern, with IAM policies that match exactly
the operations you call. The same `Stream`-shaped consumer
surface drives every event source you've added, so adding more
(SNS topics, EventBridge buses, Step Functions invocations) is
a matter of declaring the resource and pointing `.subscribe` /
`.process` at it.
