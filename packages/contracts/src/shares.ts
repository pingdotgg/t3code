import * as Schema from "effect/Schema";
import { IsoDateTime, ThreadId } from "./baseSchemas.ts";
import {
  ItemLifecyclePayload,
  ToolActivitySurface,
  ToolLifecycleItemType,
} from "./providerRuntime.ts";

export const ShareCode = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{32}$/));
export const ShareOptions = Schema.Struct({
  includeToolCalls: Schema.Boolean,
  includeToolResults: Schema.Boolean,
  includePlans: Schema.Boolean,
});
export type ShareOptions = typeof ShareOptions.Type;

export const CreateShareInput = Schema.Struct({ threadId: ThreadId, options: ShareOptions });
export type CreateShareInput = typeof CreateShareInput.Type;

export const ShareSummary = Schema.Struct({
  code: ShareCode,
  title: Schema.String,
  createdAt: IsoDateTime,
  options: ShareOptions,
});
export type ShareSummary = typeof ShareSummary.Type;

const SharedEntry = {
  id: Schema.String,
  createdAt: IsoDateTime,
  turnId: Schema.NullOr(Schema.String),
};

export const SharedThread = Schema.Struct({
  ...ShareSummary.fields,
  provider: Schema.NullOr(Schema.String),
  messages: Schema.Array(
    Schema.Struct({
      ...SharedEntry,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
    }),
  ),
  tools: Schema.Array(
    Schema.Struct({
      ...SharedEntry,
      name: Schema.String,
      itemType: Schema.optional(ToolLifecycleItemType),
      status: ItemLifecyclePayload.fields.status,
      toolSurface: Schema.optional(ToolActivitySurface),
      title: Schema.optional(Schema.String),
      detail: Schema.optional(Schema.String),
      input: Schema.optional(Schema.String),
      result: Schema.optional(Schema.String),
    }),
  ),
  plans: Schema.Array(Schema.Struct({ ...SharedEntry, text: Schema.String })),
});
export type SharedThread = typeof SharedThread.Type;
