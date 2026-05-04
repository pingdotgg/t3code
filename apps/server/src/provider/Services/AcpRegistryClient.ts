import { Schema } from "effect";

export class AcpRegistryClientError extends Schema.TaggedErrorClass<AcpRegistryClientError>()(
  "AcpRegistryClientError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
