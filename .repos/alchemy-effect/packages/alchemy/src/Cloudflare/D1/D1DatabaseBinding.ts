import * as Effect from "effect/Effect";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker } from "../Workers/Worker.ts";
import type { D1Database } from "./D1Database.ts";

export const DatabaseBinding = Effect.fn(function* (
  host: ResourceLike,
  database: D1Database,
) {
  if (isWorker(host)) {
    yield* host.bind`${database}`({
      bindings: [
        {
          type: "d1",
          name: database.LogicalId,
          databaseId: database.databaseId,
        },
      ],
    });
  } else {
    return yield* Effect.die(
      new Error(`DatabaseBinding does not support runtime '${host.Type}'`),
    );
  }
});
