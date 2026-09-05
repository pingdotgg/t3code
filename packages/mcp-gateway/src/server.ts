import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import { GatewayError, type GatewayRuntimePort } from "./port.ts";
import {
  callGatewayTool,
  type GatewayGrantSource,
  type GatewayProfileSource,
  type GatewayToolContext,
} from "./tools.ts";

const environmentId = z.string().trim().min(1);
const threadId = z.string().trim().min(1);
const idempotencyKey = z.string().trim().min(1).max(200);

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function failure(error: unknown) {
  const body =
    error instanceof GatewayError
      ? error.toJSON()
      : {
          code: "upstream_failure",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

export function createMcpGateway(input: {
  readonly port: GatewayRuntimePort;
  readonly grants: GatewayGrantSource;
  readonly profiles?: GatewayProfileSource;
}) {
  const server = new McpServer({ name: "t3-code", version: "0.1.0" });
  const context: GatewayToolContext = input;
  const register = (name: string, description: string, inputSchema: z.ZodRawShape) => {
    server.registerTool(
      name,
      { description, inputSchema: z.strictObject(inputSchema) },
      async (args) => {
        try {
          return result(await callGatewayTool(context, name, args));
        } catch (error) {
          return failure(error);
        }
      },
    );
  };

  register(
    "t3_list_profiles",
    "List named T3 chat profiles. Use a profile name when creating a chat.",
    {},
  );
  register("t3_list_environments", "List T3 environments granted to this host.", {});
  register("t3_get_environment_status", "Get connection state for one T3 environment.", {
    environmentId,
  });
  register("t3_list_projects", "List projects in one T3 environment.", { environmentId });
  register("t3_list_threads", "List chats in one T3 environment.", {
    environmentId,
    projectId: z.string().trim().min(1).optional(),
  });
  register("t3_get_thread", "Read one T3 chat and its messages.", { environmentId, threadId });
  register("t3_get_messages", "Read recent messages from one T3 chat.", {
    environmentId,
    threadId,
    limit: z.number().int().min(1).max(100).optional(),
  });
  register("t3_create_thread", "Create a chat in one T3 environment.", {
    environmentId,
    projectId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    profile: z.string().trim().min(1),
    idempotencyKey,
  });
  register("t3_send_message", "Send a user message to an existing T3 chat.", {
    environmentId,
    threadId,
    text: z.string().trim().min(1),
    idempotencyKey,
  });

  return {
    server,
    connect: (transport: Transport) => server.connect(transport),
    close: () => server.close(),
  };
}
