import * as Option from "effect/Option";
import * as AcpSchema from "./compat.ts";
import * as AcpSchemaV1 from "./_generated/schema-v1.gen.ts";
import * as AcpSchemaV2 from "./_generated/schema.gen.ts";
import { decodeNoticeUpdate, normalizeConfigOption, normalizeContentBlock, normalizeToolCallContent, normalizeToolCallUpdate } from "./clientPart2.ts";

export function normalizeConfigOptions(
  options: ReadonlyArray<AcpSchemaV2.SessionConfigOption> | undefined,
): ReadonlyArray<AcpSchema.SessionConfigOption> | undefined {
  return options?.flatMap((option) => {
    const normalized = normalizeConfigOption(option);
    return normalized === undefined ? [] : [normalized];
  });
}

export function normalizeSessionUpdate(
  notification: AcpSchemaV2.UpdateSessionNotification,
): AcpSchema.SessionNotification {
  const update = notification.update;
  const base = {
    sessionId: notification.sessionId,
    ...(notification._meta === undefined ? {} : { _meta: notification._meta }),
  };

  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const known = update as Extract<
        AcpSchemaV2.SessionUpdate,
        {
          readonly sessionUpdate:
            | "user_message_chunk"
            | "agent_message_chunk"
            | "agent_thought_chunk";
        }
      >;
      const content = normalizeContentBlock(known.content);
      return { ...base, update: { ...known, content } };
    }
    case "user_message":
    case "agent_message":
    case "agent_thought": {
      const known = update as Extract<
        AcpSchemaV2.SessionUpdate,
        { readonly sessionUpdate: "user_message" | "agent_message" | "agent_thought" }
      >;
      const content = known.content;
      return {
        ...base,
        update: {
          ...known,
          ...(content === undefined
            ? {}
            : {
                content:
                  content === null
                    ? null
                    : (content as ReadonlyArray<AcpSchemaV2.ContentBlock>).map(
                        normalizeContentBlock,
                      ),
              }),
        },
      } as AcpSchema.SessionNotification;
    }
    case "tool_call_update": {
      const known = update as Extract<
        AcpSchemaV2.SessionUpdate,
        { readonly sessionUpdate: "tool_call_update" }
      >;
      return {
        ...base,
        update: { sessionUpdate: "tool_call_update", ...normalizeToolCallUpdate(known) },
      };
    }
    case "tool_call_content_chunk": {
      const known = update as Extract<
        AcpSchemaV2.SessionUpdate,
        { readonly sessionUpdate: "tool_call_content_chunk" }
      >;
      return {
        ...base,
        update: {
          sessionUpdate: "tool_call_content_chunk",
          toolCallId: known.toolCallId,
          content: normalizeToolCallContent(known.content),
          ...(known._meta === undefined ? {} : { _meta: known._meta }),
        },
      };
    }
    case "config_option_update": {
      const known = update as Extract<
        AcpSchemaV2.SessionUpdate,
        { readonly sessionUpdate: "config_option_update" }
      >;
      return {
        ...base,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: known.configOptions.flatMap((option) => {
            const normalized = normalizeConfigOption(option);
            return normalized === undefined ? [] : [normalized];
          }),
          ...(known._meta === undefined ? {} : { _meta: known._meta }),
        },
      };
    }
    case "state_update":
    case "terminal_update":
    case "terminal_output_chunk":
    case "plan_update":
    case "plan_removed":
    case "session_info_update":
    case "usage_update":
    case "compaction_update":
    case "compaction_summary_chunk":
      return { ...base, update } as AcpSchema.SessionNotification;
    case "available_commands_update": {
      const known = update as Extract<
        AcpSchemaV2.SessionUpdate,
        { readonly sessionUpdate: "available_commands_update" }
      >;
      return {
        ...base,
        update: {
          ...known,
          availableCommands: known.availableCommands.map((command) => ({
            ...command,
            ...(command.input?.type === "text"
              ? {
                  input: command.input as Extract<
                    AcpSchemaV2.AvailableCommandInput,
                    { readonly type: "text" }
                  >,
                }
              : { input: null }),
          })),
        },
      };
    }
    default: {
      const notice = decodeNoticeUpdate(update);
      if (Option.isSome(notice)) return { ...base, update: notice.value };
      return {
        ...base,
        update: {
          sessionUpdate: "_t3_unknown",
          originalSessionUpdate: update.sessionUpdate,
          raw: update,
        },
      };
    }
  }
}

export function normalizeV1SessionUpdate(
  notification: AcpSchemaV1.SessionNotification,
): AcpSchema.SessionNotification {
  // v1 passes unknown updates through raw, so a malformed notice must not reach consumers as one.
  if ((notification.update.sessionUpdate as string) === "notice") {
    const notice = decodeNoticeUpdate(notification.update);
    return {
      ...notification,
      update: Option.isSome(notice)
        ? notice.value
        : {
            sessionUpdate: "_t3_unknown",
            originalSessionUpdate: "notice",
            raw: notification.update,
          },
    };
  }
  if (notification.update.sessionUpdate !== "available_commands_update") {
    return notification as unknown as AcpSchema.SessionNotification;
  }
  return {
    ...notification,
    update: {
      ...notification.update,
      availableCommands: notification.update.availableCommands.map((command) => {
        const { input, ...rest } = command;
        return {
          ...rest,
          ...(input == null ? {} : { input: { type: "text" as const, hint: input.hint } }),
        };
      }),
    },
  };
}

export function toV2McpServer(server: AcpSchema.McpServer): AcpSchemaV2.McpServer {
  if ("type" in server) return server;
  return {
    type: "stdio",
    name: server.name,
    command: server.command,
    ...(server.args === undefined ? {} : { args: server.args }),
    ...(server.env === undefined ? {} : { env: server.env }),
    ...(server._meta === undefined ? {} : { _meta: server._meta }),
  };
}

export function toV2ResumeRequest(
  request: AcpSchema.ResumeSessionRequest,
  replayFrom?: AcpSchemaV2.ReplayFrom,
): AcpSchemaV2.ResumeSessionRequest {
  const { mcpServers, ...rest } = request;
  return {
    ...rest,
    ...(mcpServers === undefined ? {} : { mcpServers: mcpServers.map(toV2McpServer) }),
    ...(replayFrom === undefined ? {} : { replayFrom }),
  };
}
