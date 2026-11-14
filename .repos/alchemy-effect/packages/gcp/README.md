# @alchemy.run/gcp

Google Cloud for [Alchemy](https://alchemy.run). Declare Cloud Run, Firestore, Pub/Sub, BigQuery, Secret Manager and more in the same TypeScript program as the code that uses them. Bindings grant the IAM roles for you.

```sh
npm install alchemy @alchemy.run/gcp effect
```

A Cloud Run function declares a Firestore database and binds it:

```typescript
// src/api.ts
import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export default class Api extends GCP.Function<Api>()(
  "Api",
  { main: import.meta.url, location: "us-central1" },
  Effect.gen(function* () {
    const links = yield* GCP.Firestore.Database("Links", {
      location: "us-central1",
      type: "FIRESTORE_NATIVE",
    });
    // Grants the role on the service's own service account.
    const db = yield* GCP.Firestore.ReadWriteDatabase(links);

    return {
      fetch: Effect.gen(function* () {
        yield* db.set("links/demo", { url: "https://alchemy.run" });
        const link = yield* db.get("links/demo");
        return yield* HttpServerResponse.json(link?.fields ?? {});
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(GCP.Firestore.ReadWriteDatabaseHttp)),
) {}
```

The Stack deploys it:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: GCP.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.uri };
  }),
);
```

## Learn more

- [Google Cloud on alchemy.run](https://alchemy.run/gcp)
- [Setup](https://alchemy.run/gcp/setup)
- [API reference](https://alchemy.run/providers)
