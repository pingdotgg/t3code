import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpError from "./errors.ts";
import * as AcpProtocol from "./protocol.ts";
import * as AcpSchema from "./compat.ts";
import * as AcpSchemaV1 from "./_generated/schema-v1.gen.ts";
import * as AcpSchemaV2 from "./_generated/schema.gen.ts";

export const decodeElicitationRequest = Schema.decodeUnknownEffect(
  Schema.Union([AcpSchemaV2.CreateElicitationRequest, AcpSchemaV1.CreateElicitationRequest]),
);

// ACP session notices postdate the pinned v1.21 and v2 alpha.3 schemas, so they arrive as unknown updates.
export const decodeNoticeUpdate = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionUpdate: Schema.Literal("notice"),
    severity: Schema.String,
    title: Schema.NonEmptyString,
    description: Schema.optionalKey(Schema.NullOr(Schema.String)),
    _meta: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Json))),
  }),
);

export interface AcpClientOptions {
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: AcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onIncomingRequest?: AcpProtocol.AcpPatchedProtocolOptions["onIncomingRequest"];
  readonly onTermination?: AcpProtocol.AcpPatchedProtocolOptions["onTermination"];
  readonly onOutgoingResponseFailure?: AcpProtocol.AcpPatchedProtocolOptions["onOutgoingResponseFailure"];
  readonly onOutgoingResponse?: AcpProtocol.AcpPatchedProtocolOptions["onOutgoingResponse"];
  readonly transformStdout?: (
    stdout: ChildProcessSpawner.ChildProcessHandle["stdout"],
  ) => AcpProtocol.AcpStdio["stdin"];
  readonly transformSessionUpdate?: (
    notification: AcpSchema.SessionNotification,
  ) => AcpSchema.SessionNotification;
}

export type AcpClientRaw = {
  readonly notifications: Stream.Stream<AcpProtocol.AcpIncomingNotification>;
  readonly request: (method: string, payload: unknown) => Effect.Effect<unknown, AcpError.AcpError>;
  readonly notify: (method: string, payload: unknown) => Effect.Effect<void, AcpError.AcpError>;
};

export type AcpRequestHandler<Request, Response> = AcpProtocol.AcpRequestHandler<Request, Response>;

export interface AcpCoreRequestHandlers {
  requestPermission?: AcpRequestHandler<
    AcpSchema.RequestPermissionRequest,
    AcpSchema.RequestPermissionResponse
  >;
  elicitation?: AcpRequestHandler<
    AcpSchema.CreateElicitationRequest,
    AcpSchema.CreateElicitationResponse
  >;
  mcpConnect?: AcpRequestHandler<AcpSchema.ConnectMcpRequest, AcpSchema.ConnectMcpResponse>;
  mcpMessage?: AcpRequestHandler<AcpSchema.MessageMcpRequest, AcpSchema.MessageMcpResponse>;
  mcpDisconnect?: AcpRequestHandler<
    AcpSchema.DisconnectMcpRequest,
    AcpSchema.DisconnectMcpResponse
  >;
  readTextFile?: AcpRequestHandler<AcpSchema.ReadTextFileRequest, AcpSchema.ReadTextFileResponse>;
  writeTextFile?: AcpRequestHandler<
    AcpSchema.WriteTextFileRequest,
    AcpSchema.WriteTextFileResponse | void
  >;
  createTerminal?: AcpRequestHandler<
    AcpSchema.CreateTerminalRequest,
    AcpSchema.CreateTerminalResponse
  >;
  terminalOutput?: AcpRequestHandler<
    AcpSchema.TerminalOutputRequest,
    AcpSchema.TerminalOutputResponse
  >;
  terminalWaitForExit?: AcpRequestHandler<
    AcpSchema.WaitForTerminalExitRequest,
    AcpSchema.WaitForTerminalExitResponse
  >;
  terminalKill?: AcpRequestHandler<
    AcpSchema.KillTerminalRequest,
    AcpSchema.KillTerminalResponse | void
  >;
  terminalRelease?: AcpRequestHandler<
    AcpSchema.ReleaseTerminalRequest,
    AcpSchema.ReleaseTerminalResponse | void
  >;
}

export interface AcpNotificationHandlers {
  readonly sessionUpdate: BufferedNotificationHandler<AcpSchema.SessionNotification>;
  readonly elicitationComplete: BufferedNotificationHandler<AcpSchema.CompleteElicitationNotification>;
}

export interface BufferedNotificationHandler<A> {
  readonly handlers: Array<(notification: A) => Effect.Effect<void, AcpError.AcpError>>;
  readonly pending: Array<A>;
}

export function normalizeContentBlock(content: AcpSchemaV2.ContentBlock): AcpSchema.ContentBlock {
  switch (content.type) {
    case "text":
    case "image":
    case "audio":
    case "resource_link":
    case "resource":
      return content as AcpSchema.ContentBlock;
    default:
      return { type: "_t3_unknown", originalType: content.type, raw: content };
  }
}

export function normalizeToolCallContent(content: AcpSchemaV2.ToolCallContent): AcpSchema.ToolCallContent {
  if (content.type === "content") {
    const known = content as Extract<AcpSchemaV2.ToolCallContent, { readonly type: "content" }>;
    return { ...known, content: normalizeContentBlock(known.content) };
  }
  if (content.type === "terminal") {
    return content as Extract<AcpSchemaV2.ToolCallContent, { readonly type: "terminal" }>;
  }
  if (content.type !== "diff") {
    return { type: "_t3_unknown", originalType: content.type, raw: content };
  }

  return content as Extract<AcpSchemaV2.ToolCallContent, { readonly type: "diff" }>;
}

export function normalizeToolCallUpdate(update: AcpSchemaV2.ToolCallUpdate): AcpSchema.ToolCallUpdate {
  return {
    toolCallId: update.toolCallId,
    ...(update.name === undefined ? {} : { name: update.name }),
    ...(update.title === undefined ? {} : { title: update.title }),
    ...(update.kind === undefined ? {} : { kind: update.kind }),
    ...(update.status === undefined ? {} : { status: update.status }),
    ...(update.content === undefined
      ? {}
      : {
          content: update.content === null ? null : update.content.map(normalizeToolCallContent),
        }),
    ...(update.locations === undefined ? {} : { locations: update.locations }),
    ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
    ...(update.rawOutput === undefined ? {} : { rawOutput: update.rawOutput }),
    ...(update._meta === undefined ? {} : { _meta: update._meta }),
  };
}

export function normalizeConfigOption(
  option: AcpSchemaV2.SessionConfigOption,
): AcpSchema.SessionConfigOption | undefined {
  if (option.type === "boolean") {
    const known = option as Extract<AcpSchemaV2.SessionConfigOption, { readonly type: "boolean" }>;
    return {
      type: "boolean",
      id: known.configId,
      name: known.name,
      currentValue: known.currentValue,
      ...(known.description === undefined ? {} : { description: known.description }),
      ...(known.category === undefined ? {} : { category: known.category }),
      ...(known._meta === undefined ? {} : { _meta: known._meta }),
    };
  }
  if (option.type === "select") {
    const known = option as Extract<AcpSchemaV2.SessionConfigOption, { readonly type: "select" }>;
    return {
      type: "select",
      id: known.configId,
      name: known.name,
      currentValue: known.currentValue,
      options: known.options,
      ...(known.description === undefined ? {} : { description: known.description }),
      ...(known.category === undefined ? {} : { category: known.category }),
      ...(known._meta === undefined ? {} : { _meta: known._meta }),
    };
  }
  return undefined;
}
