# @alchemy.run/cloudflare

Cloudflare for [Alchemy](https://alchemy.run). Declare Workers, Durable Objects, R2, KV, D1, Queues, Workflows, and Containers in the same TypeScript program as the code that uses them.

```sh
npm install alchemy @alchemy.run/cloudflare effect
```

A Worker binds a bucket and gets a typed client for it:

```typescript
// src/worker.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Bucket = Cloudflare.R2.Bucket("Bucket");

export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Bucket);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = request.url.split("/").pop()!;
        if (request.method === "PUT") {
          yield* bucket.put(key, yield* request.text);
          return HttpServerResponse.empty({ status: 201 });
        }
        const object = yield* bucket.get(key);
        if (object === null) {
          return HttpServerResponse.text("Not found", { status: 404 });
        }
        return HttpServerResponse.text(yield* object.text());
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
);
```

The Stack deploys it:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return { url: worker.url };
  }),
);
```

`alchemy deploy` creates the bucket and the Worker and wires the binding between them. `alchemy dev` runs the same program locally.

## Learn more

- [Cloudflare on alchemy.run](https://alchemy.run/cloudflare)
- [Getting started](https://alchemy.run/getting-started)
- [Tutorial](https://alchemy.run/cloudflare/tutorial/part-1)
- [API reference](https://alchemy.run/providers)
