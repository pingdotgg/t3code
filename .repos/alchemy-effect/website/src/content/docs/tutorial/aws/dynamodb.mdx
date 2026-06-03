---
title: Store Records in DynamoDB
description: Add a DynamoDB Table, bind GetItem and PutItem to your Lambda, and serve a typed key/value HTTP API backed by DynamoDB.
sidebar:
  order: 4
---

S3 is great for blobs, but most applications want **structured
records** they can look up by key. In this part you'll add a
**DynamoDB Table** to your Stack and bind `GetItem` + `PutItem`
to the Lambda — same pattern as S3, different storage.

## Define the table

DynamoDB tables need a partition key (and optionally a sort key)
declared up-front. Yield the `Table` resource in the function's
outer init, mirroring how you added the bucket:

```diff lang="typescript"
// src/api.ts
import * as AWS from "alchemy/AWS";
+import * as DynamoDB from "alchemy/AWS/DynamoDB";
import * as S3 from "alchemy/AWS/S3";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
// ...

Effect.gen(function* () {
  const bucket = yield* S3.Bucket("Blobs");
+  const table = yield* DynamoDB.Table("Items", {
+    partitionKey: "id",
+    attributes: {
+      id: "S",
+    },
+  });

  // ... existing bindings + handler ...
});
```

`attributes` only needs to list the attributes used by keys (and
secondary indexes) — DynamoDB itself is schemaless on the rest of
the row. `"S"` is the AWS shorthand for "string"; `"N"` is number
and `"B"` is binary.

## Bind GetItem and PutItem

Same shape as the S3 bindings — `bind(table)` returns a callable
Effect and quietly attaches a least-privilege IAM policy scoped to
this table's ARN:

```diff lang="typescript"
Effect.gen(function* () {
  const bucket = yield* S3.Bucket("Blobs");
  const table = yield* DynamoDB.Table("Items", { /* ... */ });

  const putObject = yield* S3.PutObject.bind(bucket);
  const getObject = yield* S3.GetObject.bind(bucket);
+  const putItem = yield* DynamoDB.PutItem.bind(table);
+  const getItem = yield* DynamoDB.GetItem.bind(table);

  return { fetch: /* ... */ };
});
```

## Write items with `PUT /items/:id`

Add a branch to `fetch` that writes a row keyed by the URL
segment. DynamoDB takes attribute values in their native typed
form — `{ S: "..." }` for strings, `{ N: "42" }` for numbers —
and Alchemy bindings deliberately **don't** auto-marshal so you
stay on the raw SDK shape:

```diff lang="typescript"
fetch: Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  const url = new URL(request.url);
  const path = url.pathname;

+  if (path.startsWith("/items/") && request.method === "PUT") {
+    const id = path.slice("/items/".length);
+    const content = yield* request.text;
+    yield* putItem({
+      Item: {
+        id: { S: id },
+        content: { S: content },
+      },
+    });
+    return HttpServerResponse.empty({ status: 204 });
+  }

  // ... existing /:key blob routes ...
}).pipe(Effect.orDie),
```

Skipping marshalling keeps the binding tiny and avoids a
debate over which marshalling layer to use. If you want a
typed-object API across your codebase, build it as a thin
wrapper around `putItem` — the binding won't fight you.

## Read items with `GET /items/:id`

The read path uses `getItem` with the same `{ S: id }` key
shape:

```diff lang="typescript"
if (path.startsWith("/items/") && request.method === "PUT") {
  // ... unchanged ...
}

+if (path.startsWith("/items/") && request.method === "GET") {
+  const id = path.slice("/items/".length);
+  const result = yield* getItem({ Key: { id: { S: id } } });
+  if (!result.Item) {
+    return HttpServerResponse.text("Not found", { status: 404 });
+  }
+  return yield* HttpServerResponse.json({
+    id: result.Item.id?.S,
+    content: result.Item.content?.S,
+  });
+}
```

`getItem` returns `result.Item` as `undefined` when the row
doesn't exist — no need for a typed `catchTag` like S3's
`NoSuchKey`. Map the AWS attribute-value shape back to a plain
object at the response boundary.

## Provide the runtime layers

Add the DynamoDB lives next to the S3 ones:

```diff lang="typescript"
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      AWS.Lambda.BucketEventSource,
+      DynamoDB.GetItemLive,
+      DynamoDB.PutItemLive,
      S3.PutObjectLive,
      S3.GetObjectLive,
    ),
  ),
),
```

## Deploy and verify

```sh
bun alchemy deploy
```

Add a round-trip test that exercises the new routes:

```typescript
// test/integ.test.ts
test(
  "DynamoDB round-trip",
  Effect.gen(function* () {
    const { url } = yield* stack;

    yield* HttpClient.put(`${url}/items/abc`, {
      body: HttpBody.text("hello dynamo"),
    });

    const get = yield* HttpClient.get(`${url}/items/abc`);
    expect(yield* get.json).toEqual({ id: "abc", content: "hello dynamo" });
  }),
);
```

```sh
bun test test/integ.test.ts
```

The IAM policy attached to your function role now includes
`dynamodb:GetItem` and `dynamodb:PutItem` — both scoped to this
specific table — alongside the S3 grants.

Next you'll [process DynamoDB Streams](/tutorial/aws/dynamodb-streams)
so changes to the table fan out into a Lambda-side `Stream` you
can react to.
