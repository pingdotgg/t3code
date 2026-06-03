import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";

export const createWorkerName = (id: string, name: string | undefined) =>
  name
    ? Effect.succeed(name)
    : createPhysicalName({
        id,
        maxLength: 54,
      }).pipe(Effect.map((name) => name.toLowerCase()));
