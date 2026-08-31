import * as Schema from "effect/Schema";

export class P2pKeyDecodeError extends Schema.TaggedErrorClass<P2pKeyDecodeError>()(
  "P2pKeyDecodeError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class P2pAnnounceError extends Schema.TaggedErrorClass<P2pAnnounceError>()(
  "P2pAnnounceError",
  {
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class P2pDialError extends Schema.TaggedErrorClass<P2pDialError>()("P2pDialError", {
  detail: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.detail;
  }
}
