---
title: React to S3 Events
description: Subscribe a Lambda Function to S3 bucket notifications, process them as an Effect Stream, and let Alchemy wire up the IAM and event-source plumbing.
sidebar:
  order: 3
---

Reading and writing S3 objects on demand is one half of the story.
The other half is **reacting** to objects as they arrive — for
indexing, virus scanning, thumbnail generation, you name it. In
this part you'll subscribe the same Lambda from the previous part
to bucket notifications and process them as an Effect `Stream`.

## Subscribe to bucket notifications

Bucket notifications live behind an Alchemy helper:
`S3.notifications(bucket).subscribe(process)`. Add the smallest
possible subscription — log every new object's key — alongside
the existing bindings:

```diff lang="typescript"
// src/api.ts
import * as AWS from "alchemy/AWS";
import * as S3 from "alchemy/AWS/S3";
+import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
+import * as Stream from "effect/Stream";
// ...

Effect.gen(function* () {
  const bucket = yield* S3.Bucket("Blobs");
  const putObject = yield* S3.PutObject.bind(bucket);
  const getObject = yield* S3.GetObject.bind(bucket);

+  yield* S3.notifications(bucket).subscribe((stream) =>
+    stream.pipe(
+      Stream.runForEach((event) =>
+        Console.log(`new object: ${event.key}`),
+      ),
+    ),
+  );

  return {
    fetch: /* ... unchanged ... */,
  };
});
```

That single `yield*` does three things in one shot: it
configures the bucket's notification settings to push events
into the function, adds the `lambda:InvokeFunction` permission
S3 needs to call you, and registers the stream handler that
runs every time an event batch lands.

## Filter the event types

Without a filter you get every notification S3 emits — object
created, deleted, restored, replicated, the lot. Constrain the
subscription to a specific subset with `events`:

```diff lang="typescript"
-yield* S3.notifications(bucket).subscribe((stream) =>
+yield* S3.notifications(bucket, {
+  events: ["s3:ObjectCreated:*"],
+}).subscribe((stream) =>
  stream.pipe(
    Stream.runForEach((event) =>
      Console.log(`new object: ${event.key}`),
    ),
  ),
);
```

The `events` filter is type-checked against the AWS S3 event
catalog, so typos surface at the call site rather than at deploy
time.

## What the stream actually carries

`stream` is a `Stream.Stream<BucketNotification>` — a normalized
shape with `type`, `bucket`, `key`, `size`, and `eTag`. Each
Lambda invocation delivers one batch as one stream emission
sequence, then completes; the next invocation starts a fresh
stream. Treating events as a `Stream` means the usual operators
(`mapEffect`, `groupedWithin`, `mapAccum`) work without thinking
about the Lambda payload envelope.

## Provide the runtime layer

The runtime side of the subscription lives in
`Lambda.BucketEventSource`. It's the layer that turns the abstract
`BucketEventSource` capability into a concrete Lambda event-source
mapping plus IAM grant. Add it alongside the S3 bindings:

```diff lang="typescript"
}).pipe(
  Effect.provide(
-    Layer.mergeAll(S3.PutObjectLive, S3.GetObjectLive),
+    Layer.mergeAll(
+      AWS.Lambda.BucketEventSource,
+      S3.PutObjectLive,
+      S3.GetObjectLive,
+    ),
  ),
),
```

`BucketEventSource` and the `PutObject`/`GetObject` lives are all
peers here — none of them require each other — so a flat
`Layer.mergeAll(...)` is enough.

## Run an Effect per event

Logging is a good smoke test, but a real handler usually wants
to do something async per event. Swap `runForEach` for
`mapEffect` so each event runs through a generator block:

```diff lang="typescript"
yield* S3.notifications(bucket, {
  events: ["s3:ObjectCreated:*"],
}).subscribe((stream) =>
  stream.pipe(
-    Stream.runForEach((event) =>
-      Console.log(`new object: ${event.key}`),
-    ),
+    Stream.mapEffect((event) =>
+      Console.log(`new object: ${event.key}`),
+    ),
+    Stream.runDrain,
+  ),
);
```

`Stream.runDrain` consumes the stream without collecting — we
only care about the side effects, not the return values.

## Read the object back

`getObject` is already bound to the bucket, so the per-event
Effect can fetch the new object's contents inline:

```diff lang="typescript"
stream.pipe(
  Stream.mapEffect((event) =>
-    Console.log(`new object: ${event.key}`),
+    Effect.gen(function* () {
+      const result = yield* getObject({ Key: event.key });
+      const body = yield* result.Body!.pipe(
+        Stream.decodeText,
+        Stream.mkString,
+      );
+      yield* Console.log(`${event.key} -> ${body}`);
+    }).pipe(Effect.orDie),
  ),
  Stream.runDrain,
),
```

`Stream.mapEffect` is back-pressured by default — events flow
through one at a time. Pass a `concurrency` option (we'll see it
in later parts) when you want fan-out.

## Deploy and verify

```sh
bun alchemy deploy
```

The CLI applies the new bucket notification configuration and
redeploys the function with the broader IAM policy. Then trigger
the subscription end-to-end by `PUT`ing an object via the HTTP
route from the previous part:

```typescript
// test/integ.test.ts
test(
  "PUT triggers notification handler",
  Effect.gen(function* () {
    const { url } = yield* stack;
    yield* HttpClient.put(`${url}/notify-me.txt`, {
      body: HttpBody.text("payload"),
    });
    // ...optionally tail CloudWatch logs to assert the message landed
  }),
);
```

You'll see the `notify-me.txt -> payload` line in the function's
log group within a couple of seconds.

S3 events typically arrive in batches of up to 10 records — the
same `Stream` is fed each batch and completes between invocations,
so you get the same composition story whether the batch is one
event or a hundred.

Next we'll trade blob storage for structured records and
[add a DynamoDB table](/tutorial/aws/dynamodb).
