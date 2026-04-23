import type { AcpRegistryListResult } from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

export class AcpRegistryClientError extends Schema.TaggedErrorClass<AcpRegistryClientError>()(
  "AcpRegistryClientError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface AcpRegistryClientShape {
  readonly listAgents: Effect.Effect<AcpRegistryListResult, AcpRegistryClientError>;
}

export class AcpRegistryClient extends Context.Service<AcpRegistryClient, AcpRegistryClientShape>()(
  "t3/provider/Services/AcpRegistryClient",
) {}
