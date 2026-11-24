import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

export const HostResourcesSnapshot = Schema.Struct({
  sampledAt: NonNegativeInt,
  cpuUtilization: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  cpuCount: NonNegativeInt,
  availableMemoryBytes: NonNegativeInt,
  totalMemoryBytes: NonNegativeInt,
});
export type HostResourcesSnapshot = typeof HostResourcesSnapshot.Type;
