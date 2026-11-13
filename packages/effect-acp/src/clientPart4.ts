import * as Predicate from "effect/Predicate";
import * as AcpProtocol from "./protocol.ts";
import * as AcpSchema from "./compat.ts";
import * as AcpSchemaV1 from "./_generated/schema-v1.gen.ts";
import * as AcpSchemaV2 from "./_generated/schema.gen.ts";
import { normalizeToolCallUpdate } from "./clientPart2.ts";
import { normalizeConfigOptions, toV2McpServer } from "./clientPart3.ts";

export function toV2ForkRequest(request: AcpSchema.ForkSessionRequest): AcpSchemaV2.ForkSessionRequest {
  const { mcpServers, ...rest } = request;
  return {
    ...rest,
    ...(mcpServers === undefined ? {} : { mcpServers: mcpServers.map(toV2McpServer) }),
  };
}

export function normalizeInitializeResponse(
  response: AcpSchemaV2.InitializeResponse,
): AcpSchema.InitializeResponse {
  const session = response.capabilities?.session;
  const prompt = session?.prompt;
  const mcp = session?.mcp;
  return {
    protocolVersion: response.protocolVersion,
    agentInfo: response.info,
    agentCapabilities: {
      loadSession: session !== undefined && session !== null,
      promptCapabilities: {
        image: prompt?.image != null,
        audio: prompt?.audio != null,
        embeddedContext: prompt?.embeddedContext != null,
      },
      mcpCapabilities: {
        stdio: mcp?.stdio != null,
        http: mcp?.http != null,
        acp: mcp?.acp != null,
      },
      ...(session == null
        ? {}
        : {
            sessionCapabilities: {
              list: {},
              resume: {},
              close: {},
              ...(session.delete == null ? {} : { delete: {} }),
              ...(session.fork == null ? {} : { fork: {} }),
              ...(session.additionalDirectories == null ? {} : { additionalDirectories: {} }),
            },
          }),
      ...(response.capabilities?.providers == null ? {} : { providers: {} }),
      ...(response.authMethods === undefined || response.authMethods.length === 0
        ? {}
        : { auth: { logout: {} } }),
    },
    ...(response.authMethods === undefined
      ? {}
      : {
          authMethods: response.authMethods
            .map((method) => {
              const record = method as AcpSchemaV2.AuthMethod;
              const base = {
                id: record.methodId,
                name: record.name,
                ...(record.description === undefined ? {} : { description: record.description }),
                ...(record._meta === undefined ? {} : { _meta: record._meta }),
              };
              if (
                record.type === "env_var" &&
                Array.isArray(record.vars) &&
                record.vars.every(
                  (variable) =>
                    typeof variable === "object" &&
                    variable !== null &&
                    typeof (variable as { readonly name?: unknown }).name === "string",
                )
              ) {
                return {
                  ...base,
                  type: "env_var" as const,
                  vars: record.vars.map((variable) => {
                    const value = variable as { readonly name: string; readonly label?: unknown };
                    return {
                      name: value.name,
                      ...(typeof value.label === "string" ? { label: value.label } : {}),
                    };
                  }),
                  ...(typeof record.link === "string" ? { link: record.link } : {}),
                };
              }
              if (record.type === "agent") return { ...base, type: "agent" as const };
              if (record.type !== "terminal") return undefined;
              return {
                ...base,
                type: "terminal" as const,
                ...(Array.isArray(record.args)
                  ? {
                      args: record.args.filter(
                        (argument): argument is string => typeof argument === "string",
                      ),
                    }
                  : {}),
                ...(Array.isArray(record.env)
                  ? {
                      env: Object.fromEntries(
                        (record.env as ReadonlyArray<AcpSchemaV2.EnvVariable>).map((variable) => [
                          variable.name,
                          variable.value,
                        ]),
                      ),
                    }
                  : {}),
              };
            })
            .filter(Predicate.isNotUndefined),
        }),
    ...(response._meta === undefined ? {} : { _meta: response._meta }),
  };
}

function toV2InitializeRequest(
  request: AcpSchema.InitializeRequest,
): AcpSchemaV2.InitializeRequest {
  const capabilities = request.clientCapabilities;
  return {
    protocolVersion: 2,
    info: request.clientInfo ?? { name: "t3-code", version: "unknown" },
    capabilities: {
      ...(capabilities?.auth?.terminal === true ? { auth: { terminal: {} } } : {}),
      ...(capabilities?.elicitation == null ? {} : { elicitation: capabilities.elicitation }),
      ...(capabilities?._meta === undefined ? {} : { _meta: capabilities._meta }),
    },
    ...(request._meta === undefined ? {} : { _meta: request._meta }),
  };
}

export function toNegotiatingInitializeRequest(
  request: AcpSchema.InitializeRequest,
): AcpSchemaV1.InitializeRequest | AcpSchemaV2.InitializeRequest {
  return {
    ...toV2InitializeRequest(request),
    clientCapabilities: request.clientCapabilities ?? {},
    ...(request.clientInfo === undefined ? {} : { clientInfo: request.clientInfo }),
  } as unknown as AcpSchemaV1.InitializeRequest | AcpSchemaV2.InitializeRequest;
}

export function isV2InitializeResponse(
  response: AcpSchemaV1.InitializeResponse | AcpSchemaV2.InitializeResponse,
): response is AcpSchemaV2.InitializeResponse {
  return "info" in response;
}

export function normalizeV2SessionSetupResponse(
  response:
    | AcpSchemaV2.NewSessionResponse
    | AcpSchemaV2.ResumeSessionResponse
    | AcpSchemaV2.ForkSessionResponse,
) {
  const configOptions = normalizeConfigOptions(response.configOptions);
  return {
    ...("sessionId" in response ? { sessionId: response.sessionId } : {}),
    ...(configOptions === undefined ? {} : { configOptions }),
    ...(response._meta === undefined ? {} : { _meta: response._meta }),
  };
}

export function normalizePermissionRequest(
  request: AcpSchemaV2.RequestPermissionRequest,
  context: AcpProtocol.AcpRequestContext,
): AcpSchema.RequestPermissionRequest {
  const subject = request.subject;
  const toolCall =
    subject?.type === "tool_call" && "toolCall" in subject
      ? normalizeToolCallUpdate(subject.toolCall as AcpSchemaV2.ToolCallUpdate)
      : {
          toolCallId:
            subject?.type === "command" &&
            "toolCallId" in subject &&
            typeof subject.toolCallId === "string"
              ? subject.toolCallId
              : context.requestId,
          title: request.title,
          kind: subject?.type === "command" ? ("execute" as const) : ("other" as const),
        };
  return {
    sessionId: request.sessionId,
    title: request.title,
    ...(request.description === undefined ? {} : { description: request.description }),
    ...(subject === undefined ? {} : { subject }),
    toolCall,
    options: request.options,
    ...(request._meta === undefined ? {} : { _meta: request._meta }),
  };
}
