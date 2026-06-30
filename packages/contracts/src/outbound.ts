import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OutboundTrigger } from "./workflow.ts";

export const OutboundConnectionKind = Schema.Literals(["webhook", "slack"]);
export type OutboundConnectionKind = typeof OutboundConnectionKind.Type;

export const OutboundConnectionView = Schema.Struct({
  connectionRef: Schema.String,
  kind: OutboundConnectionKind,
  displayName: Schema.String,
  createdAt: Schema.String,
});
export type OutboundConnectionView = typeof OutboundConnectionView.Type;

export const CreateOutboundConnectionInput = Schema.Struct({
  kind: OutboundConnectionKind,
  displayName: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString, // validated server-side (SSRF); never echoed back
});
export type CreateOutboundConnectionInput = typeof CreateOutboundConnectionInput.Type;

// The normalized object `when` predicates evaluate against and formatters render from.
export const OutboundEventContext = Schema.Struct({
  trigger: OutboundTrigger,
  ticketId: Schema.String,
  boardId: Schema.String,
  title: Schema.String,
  status: Schema.String,
  fromLane: Schema.NullOr(Schema.String),
  toLane: Schema.NullOr(Schema.String),
  isTerminal: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  occurredAt: Schema.String,
});
export type OutboundEventContext = typeof OutboundEventContext.Type;
