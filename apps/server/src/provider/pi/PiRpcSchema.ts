import * as Schema from "effect/Schema";

export const PiThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type PiThinkingLevel = typeof PiThinkingLevel.Type;

export const PiRpcModel = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  provider: Schema.String,
  api: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  contextWindow: Schema.optional(Schema.Number),
  maxTokens: Schema.optional(Schema.Number),
});
export type PiRpcModel = typeof PiRpcModel.Type;

export const PiRpcState = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  sessionFile: Schema.optional(Schema.String),
  messageCount: Schema.optional(Schema.Number),
  pendingMessageCount: Schema.optional(Schema.Number),
  isStreaming: Schema.optional(Schema.Boolean),
  model: Schema.optional(PiRpcModel),
  thinkingLevel: Schema.optional(PiThinkingLevel),
});
export type PiRpcState = typeof PiRpcState.Type;

export const PiRpcAvailableModels = Schema.Struct({ models: Schema.Array(PiRpcModel) });
export type PiRpcAvailableModels = typeof PiRpcAvailableModels.Type;

const PiRpcSessionTokens = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  total: Schema.Number,
});

const PiRpcContextUsage = Schema.Struct({
  tokens: Schema.NullOr(Schema.Number),
  contextWindow: Schema.Number,
  percent: Schema.NullOr(Schema.Number),
});

export const PiRpcSessionStats = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  tokens: PiRpcSessionTokens,
  contextUsage: Schema.optional(PiRpcContextUsage),
});
export type PiRpcSessionStats = typeof PiRpcSessionStats.Type;

export const PiRpcCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  source: Schema.Literals(["extension", "prompt", "skill"]),
  sourceInfo: Schema.Struct({
    path: Schema.String,
    source: Schema.String,
    scope: Schema.String,
    origin: Schema.String,
    baseDir: Schema.optional(Schema.String),
  }),
});
export type PiRpcCommand = typeof PiRpcCommand.Type;

export const PiRpcCommands = Schema.Struct({ commands: Schema.Array(PiRpcCommand) });
export type PiRpcCommands = typeof PiRpcCommands.Type;

export const PiRpcResponse = Schema.Struct({
  type: Schema.Literal("response"),
  command: Schema.String,
  success: Schema.Boolean,
  id: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
export type PiRpcResponse = typeof PiRpcResponse.Type;

export const isPiRpcResponse = Schema.is(PiRpcResponse);
export type PiRpcRawEvent = Readonly<Record<string, unknown>>;

export interface PiRpcProtocolFailureEvent {
  readonly _tag: "PiRpcProtocolFailureEvent";
  readonly reason: "MalformedJson" | "LineTooLong";
  readonly line?: string;
  readonly detail: string;
}

export interface PiRpcOutputLineEvent {
  readonly _tag: "PiRpcOutputLineEvent";
  readonly line: string;
}

export type PiRpcEvent = PiRpcRawEvent | PiRpcProtocolFailureEvent | PiRpcOutputLineEvent;
