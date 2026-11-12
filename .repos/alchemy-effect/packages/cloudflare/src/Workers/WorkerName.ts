import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";

export const createWorkerName = (id: string, name: string | undefined) =>
  name
    ? Effect.succeed(name)
    : createPhysicalName({
        id,
        maxLength: 54,
      }).pipe(Effect.map((name) => name.toLowerCase()));
