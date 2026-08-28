import {
  OpenCode,
  type AgentInfo,
  type FormAnswer,
  type FormField1,
  type FormInfo1,
  type ModelInfo,
  type ModelRef,
  type OpenCodeEvent,
  type ProviderInfo,
  type SessionInfo,
  type SessionMessageAssistant,
  type SessionMessageAssistantTool,
  type SessionMessageInfo,
  type SessionStructuredError,
  type ToolContent,
  type ToolContent1,
} from "@opencode-ai/client";
import * as DateTime from "effect/DateTime";
import type {
  Agent,
  AssistantMessage,
  Event,
  FilePart,
  Model,
  OpencodeClient,
  Part,
  PermissionRequest,
  PermissionRuleset,
  Provider,
  ProviderListResponse,
  QuestionAnswer,
  QuestionInfo,
  Session,
  SessionMessagesResponse,
  SessionPromptResponse,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2";

type LegacySessionCreateInput = NonNullable<Parameters<OpencodeClient["session"]["create"]>[0]>;
type LegacySessionGetInput = Parameters<OpencodeClient["session"]["get"]>[0];
type LegacySessionUpdateInput = Parameters<OpencodeClient["session"]["update"]>[0];
type LegacySessionForkInput = Parameters<OpencodeClient["session"]["fork"]>[0];
type LegacySessionPromptInput = Parameters<OpencodeClient["session"]["prompt"]>[0];
type LegacySessionMessagesInput = Parameters<OpencodeClient["session"]["messages"]>[0];
type LegacySessionRevertInput = Parameters<OpencodeClient["session"]["revert"]>[0];
type LegacyPermissionReplyInput = Parameters<OpencodeClient["permission"]["reply"]>[0];
type LegacyQuestionReplyInput = Parameters<OpencodeClient["question"]["reply"]>[0];
type LegacyMcpAddInput = NonNullable<Parameters<OpencodeClient["mcp"]["add"]>[0]>;
type LegacySubscribeOptions = Parameters<OpencodeClient["event"]["subscribe"]>[1];
type LegacyMessageEntry = SessionMessagesResponse[number];
type V2Client = ReturnType<typeof OpenCode.make>;

interface OpenCodeV2ClientInput {
  readonly baseUrl: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly fetch?: typeof globalThis.fetch;
}

interface StreamState {
  readonly assistants: Map<string, AssistantMessage>;
  readonly parts: Map<string, Part>;
  readonly tools: Map<string, ToolPart>;
  readonly pendingUsers: Map<string, Extract<OpenCodeEvent, { type: "session.inbox.enqueued" }>>;
  readonly latestUsers: Map<string, string>;
}

const EMPTY_TOKENS = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
} as const;

export function createOpenCodeV2Client(input: OpenCodeV2ClientInput): OpencodeClient {
  const location = { directory: input.directory };
  const client = OpenCode.make({
    baseUrl: input.baseUrl,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.serverPassword
      ? {
          headers: {
            Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
          },
        }
      : {}),
  });
  const sessions = new Map<string, Session>();
  const permissionsBySession = new Map<string, PermissionRuleset>();
  const permissionSessions = new Map<string, string>();
  const approvedPermissions = new Set<string>();
  const forms = new Map<string, FormInfo1>();

  const rememberSession = (session: SessionInfo): Session => {
    const converted = toLegacySession(session, permissionsBySession.get(session.id));
    sessions.set(session.id, converted);
    return converted;
  };

  const getSession = async (parameters: LegacySessionGetInput) => ({
    data: rememberSession(await client.session.get({ sessionID: parameters.sessionID })),
  });

  const listMessages = async (
    parameters: LegacySessionMessagesInput,
  ): Promise<{ readonly data: SessionMessagesResponse }> => {
    const messages: SessionMessagesResponse = [];
    const limit = parameters.limit;
    const pageSize = Math.min(limit ?? 200, 200);
    let cursor: string | undefined;
    let latestUser: string | undefined;

    do {
      const page = await client.message.list({
        sessionID: parameters.sessionID,
        limit: pageSize,
        order: "asc",
        ...(cursor ? { cursor } : {}),
      });

      for (const message of page.data) {
        if (message.type !== "user" && message.type !== "assistant") {
          continue;
        }
        if (message.type === "user") {
          latestUser = message.id;
        }
        messages.push(
          toLegacyMessage(
            message,
            parameters.sessionID,
            sessions.get(parameters.sessionID),
            latestUser,
          ),
        );
        if (limit !== undefined && messages.length >= limit) {
          return { data: messages };
        }
      }

      const next = page.cursor.next ?? undefined;
      if (!next || next === cursor) {
        break;
      }
      cursor = next;
    } while (cursor !== undefined);

    return { data: messages };
  };

  const submitPrompt = async (parameters: LegacySessionPromptInput) => {
    const session = sessions.get(parameters.sessionID);

    if (parameters.model) {
      const model: ModelRef = {
        id: parameters.model.modelID,
        providerID: parameters.model.providerID,
        ...(parameters.variant ? { variant: parameters.variant } : {}),
      };
      if (
        session?.model?.id !== model.id ||
        session.model.providerID !== model.providerID ||
        session.model.variant !== model.variant
      ) {
        await client.session.switchModel({ sessionID: parameters.sessionID, model });
        if (session) {
          sessions.set(parameters.sessionID, { ...session, model });
        }
      }
    }

    if (parameters.agent && session?.agent !== parameters.agent) {
      await client.session.switchAgent({
        sessionID: parameters.sessionID,
        agent: parameters.agent,
      });
      const current = sessions.get(parameters.sessionID);
      if (current) {
        sessions.set(parameters.sessionID, { ...current, agent: parameters.agent });
      }
    }

    const parts = parameters.parts ?? [];
    const files = parts.flatMap((part) =>
      part.type === "file"
        ? [{ uri: part.url, ...(part.filename ? { name: part.filename } : {}) }]
        : [],
    );
    const agents = parts.flatMap((part) =>
      part.type === "agent"
        ? [
            {
              name: part.name,
              ...(part.source
                ? {
                    mention: {
                      start: part.source.start,
                      end: part.source.end,
                      text: part.source.value,
                    },
                  }
                : {}),
            },
          ]
        : [],
    );

    return client.session.prompt({
      sessionID: parameters.sessionID,
      ...(parameters.messageID ? { id: parameters.messageID } : {}),
      text: parts
        .flatMap((part) => (part.type === "text" && !part.ignored ? [part.text] : []))
        .join("\n"),
      ...(files.length > 0 ? { files } : {}),
      ...(agents.length > 0 ? { agents } : {}),
      delivery: "steer",
      ...(parameters.noReply ? { resume: false } : {}),
    });
  };

  async function* translateEvents(source: AsyncIterable<OpenCodeEvent>): AsyncGenerator<Event> {
    const state: StreamState = {
      assistants: new Map(),
      parts: new Map(),
      tools: new Map(),
      pendingUsers: new Map(),
      latestUsers: new Map(),
    };

    const ensureAssistant = (
      event: OpenCodeEvent,
      sessionID: string,
      messageID: string,
      model?: ModelRef,
      agent?: string,
    ): { readonly info: AssistantMessage; readonly created: boolean } => {
      const previous = state.assistants.get(messageID);
      if (previous) {
        return { info: previous, created: false };
      }
      const session = sessions.get(sessionID);
      const selectedModel = model ?? session?.model ?? { id: "", providerID: "" };
      const selectedAgent = agent ?? session?.agent ?? "";
      const directory = session?.directory ?? event.location?.directory ?? input.directory;
      const info: AssistantMessage = {
        id: messageID,
        sessionID,
        role: "assistant",
        time: { created: eventTimestamp(event) },
        parentID: state.latestUsers.get(sessionID) ?? "",
        modelID: selectedModel.id,
        providerID: selectedModel.providerID,
        mode: selectedAgent,
        agent: selectedAgent,
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { ...EMPTY_TOKENS, cache: { ...EMPTY_TOKENS.cache } },
        ...(selectedModel.variant ? { variant: selectedModel.variant } : {}),
      };
      state.assistants.set(messageID, info);
      return { info, created: true };
    };

    for await (const event of source) {
      switch (event.type) {
        case "server.connected":
          yield { id: event.id, type: "server.connected", properties: {} };
          break;

        case "session.created": {
          const permission = permissionsBySession.get(event.data.sessionID);
          const info: Session = {
            id: event.data.sessionID,
            slug: event.data.slug,
            projectID: event.data.projectID,
            directory: event.data.location.directory,
            title: event.data.title ?? "",
            version: event.data.version,
            time: { created: event.created, updated: event.created },
            ...(event.data.parentID ? { parentID: event.data.parentID } : {}),
            ...(event.data.location.workspaceID
              ? { workspaceID: event.data.location.workspaceID }
              : {}),
            ...(event.data.agent ? { agent: event.data.agent } : {}),
            ...(event.data.model ? { model: event.data.model } : {}),
            ...(permission ? { permission } : {}),
          };
          sessions.set(info.id, info);
          yield {
            id: event.id,
            type: "session.created",
            properties: { sessionID: info.id, info },
          };
          break;
        }

        case "session.renamed": {
          const previous = sessions.get(event.data.sessionID);
          const info: Session = previous
            ? {
                ...previous,
                title: event.data.title,
                time: { ...previous.time, updated: event.created },
              }
            : {
                id: event.data.sessionID,
                slug: event.data.sessionID,
                projectID: "",
                directory: event.location?.directory ?? input.directory,
                title: event.data.title,
                version: "2",
                time: { created: event.created, updated: event.created },
              };
          sessions.set(info.id, info);
          yield {
            id: event.id,
            type: "session.updated",
            properties: { sessionID: info.id, info },
          };
          break;
        }

        case "session.moved": {
          const previous = sessions.get(event.data.sessionID);
          if (previous) {
            sessions.set(event.data.sessionID, {
              ...previous,
              directory: event.data.location.directory,
              projectID: event.data.projectID,
              ...(event.data.location.workspaceID
                ? { workspaceID: event.data.location.workspaceID }
                : {}),
            });
          }
          break;
        }

        case "session.agent.selected": {
          const previous = sessions.get(event.data.sessionID);
          if (previous) {
            sessions.set(event.data.sessionID, { ...previous, agent: event.data.agent });
          }
          break;
        }

        case "session.model.selected": {
          const previous = sessions.get(event.data.sessionID);
          if (previous) {
            sessions.set(event.data.sessionID, { ...previous, model: event.data.model });
          }
          break;
        }

        case "session.deleted": {
          const info = sessions.get(event.data.sessionID);
          sessions.delete(event.data.sessionID);
          permissionsBySession.delete(event.data.sessionID);
          if (info) {
            yield {
              id: event.id,
              type: "session.deleted",
              properties: { sessionID: event.data.sessionID, info },
            };
          }
          break;
        }

        case "session.inbox.enqueued":
          if (event.data.item.type === "user") {
            state.pendingUsers.set(event.data.inboxID, event);
          }
          break;

        case "session.inbox.delivered": {
          const pending = state.pendingUsers.get(event.data.inboxID);
          state.pendingUsers.delete(event.data.inboxID);
          state.latestUsers.set(event.data.sessionID, event.data.inboxID);
          if (pending && pending.data.item.type === "user") {
            const info = toLegacyUserInfo(
              {
                id: event.data.inboxID,
                time: { created: pending.created },
              },
              event.data.sessionID,
              sessions.get(event.data.sessionID),
            );
            yield {
              id: event.id,
              type: "message.updated",
              properties: { sessionID: event.data.sessionID, info },
            };
          }
          break;
        }

        case "session.execution.started":
          yield legacySessionStatus(event.id, event.data.sessionID, { type: "busy" });
          break;

        case "session.execution.succeeded":
        case "session.execution.interrupted":
        case "session.idle":
          yield legacySessionStatus(event.id, event.data.sessionID, { type: "idle" });
          break;

        case "session.status":
          yield legacySessionStatus(event.id, event.data.sessionID, event.data.status);
          break;

        case "session.retry.scheduled":
          yield legacySessionStatus(event.id, event.data.sessionID, {
            type: "retry",
            attempt: event.data.attempt,
            message: event.data.error.message,
            next: event.data.at,
          });
          break;

        case "session.execution.failed":
          yield {
            id: event.id,
            type: "session.error",
            properties: {
              sessionID: event.data.sessionID,
              error: toLegacyError(event.data.error, sessions.get(event.data.sessionID)?.model),
            },
          };
          break;

        case "session.step.started": {
          const assistant = ensureAssistant(
            event,
            event.data.sessionID,
            event.data.assistantMessageID,
            event.data.model,
            event.data.agent,
          );
          yield {
            id: event.id,
            type: "message.updated",
            properties: { sessionID: event.data.sessionID, info: assistant.info },
          };
          break;
        }

        case "session.step.ended": {
          const assistant = ensureAssistant(
            event,
            event.data.sessionID,
            event.data.assistantMessageID,
          );
          const info: AssistantMessage = {
            ...assistant.info,
            time: { ...assistant.info.time, completed: event.created },
            finish: event.data.finish,
            cost: event.data.cost,
            tokens: event.data.tokens,
          };
          state.assistants.set(info.id, info);
          yield {
            id: event.id,
            type: "message.updated",
            properties: { sessionID: event.data.sessionID, info },
          };
          break;
        }

        case "session.step.failed": {
          const assistant = ensureAssistant(
            event,
            event.data.sessionID,
            event.data.assistantMessageID,
          );
          const info: AssistantMessage = {
            ...assistant.info,
            error: toLegacyError(event.data.error, sessions.get(event.data.sessionID)?.model),
            ...(event.data.cost !== undefined ? { cost: event.data.cost } : {}),
            ...(event.data.tokens ? { tokens: event.data.tokens } : {}),
          };
          state.assistants.set(info.id, info);
          yield {
            id: event.id,
            type: "message.updated",
            properties: { sessionID: event.data.sessionID, info },
          };
          break;
        }

        case "session.text.started":
        case "session.reasoning.started": {
          const assistant = ensureAssistant(
            event,
            event.data.sessionID,
            event.data.assistantMessageID,
          );
          if (assistant.created) {
            yield {
              id: event.id,
              type: "message.updated",
              properties: { sessionID: event.data.sessionID, info: assistant.info },
            };
          }
          const type = event.type === "session.text.started" ? "text" : "reasoning";
          const part: Part = {
            id: contentPartId(event.data.assistantMessageID, type, event.data.ordinal),
            sessionID: event.data.sessionID,
            messageID: event.data.assistantMessageID,
            type,
            text: "",
            time: { start: event.created },
          };
          state.parts.set(part.id, part);
          yield legacyPartUpdated(event.id, event.data.sessionID, part, event.created);
          break;
        }

        case "session.text.delta":
        case "session.reasoning.delta": {
          const assistant = ensureAssistant(
            event,
            event.data.sessionID,
            event.data.assistantMessageID,
          );
          if (assistant.created) {
            yield {
              id: event.id,
              type: "message.updated",
              properties: { sessionID: event.data.sessionID, info: assistant.info },
            };
          }
          const type = event.type === "session.text.delta" ? "text" : "reasoning";
          const id = contentPartId(event.data.assistantMessageID, type, event.data.ordinal);
          const previous = state.parts.get(id);
          const part: Extract<Part, { type: "text" | "reasoning" }> =
            previous && (previous.type === "text" || previous.type === "reasoning")
              ? previous
              : {
                  id,
                  sessionID: event.data.sessionID,
                  messageID: event.data.assistantMessageID,
                  type,
                  text: "",
                  time: { start: event.created },
                };
          if (part !== previous) {
            state.parts.set(id, part);
            yield legacyPartUpdated(event.id, event.data.sessionID, part, event.created);
          }
          state.parts.set(id, { ...part, text: part.text + event.data.delta });
          if (event.data.delta.length > 0) {
            yield {
              id: event.id,
              type: "message.part.delta",
              properties: {
                sessionID: event.data.sessionID,
                messageID: event.data.assistantMessageID,
                partID: id,
                field: "text",
                delta: event.data.delta,
              },
            };
          }
          break;
        }

        case "session.text.ended":
        case "session.reasoning.ended": {
          const assistant = ensureAssistant(
            event,
            event.data.sessionID,
            event.data.assistantMessageID,
          );
          if (assistant.created) {
            yield {
              id: event.id,
              type: "message.updated",
              properties: { sessionID: event.data.sessionID, info: assistant.info },
            };
          }
          const type = event.type === "session.text.ended" ? "text" : "reasoning";
          const id = contentPartId(event.data.assistantMessageID, type, event.data.ordinal);
          const previous = state.parts.get(id);
          const start =
            previous && (previous.type === "text" || previous.type === "reasoning")
              ? (previous.time?.start ?? event.created)
              : event.created;
          const part: Part = {
            id,
            sessionID: event.data.sessionID,
            messageID: event.data.assistantMessageID,
            type,
            text: event.data.text,
            time: { start, end: event.created },
          };
          state.parts.set(id, part);
          yield legacyPartUpdated(event.id, event.data.sessionID, part, event.created);
          break;
        }

        case "session.tool.input.started": {
          const assistant = ensureAssistant(
            event,
            event.data.sessionID,
            event.data.assistantMessageID,
          );
          if (assistant.created) {
            yield {
              id: event.id,
              type: "message.updated",
              properties: { sessionID: event.data.sessionID, info: assistant.info },
            };
          }
          const part: ToolPart = {
            id: event.data.id,
            sessionID: event.data.sessionID,
            messageID: event.data.assistantMessageID,
            type: "tool",
            callID: event.data.id,
            tool: legacyPermissionName(event.data.name),
            state: { status: "pending", input: {}, raw: "" },
          };
          state.tools.set(toolKey(event.data.sessionID, event.data.id), part);
          state.parts.set(part.id, part);
          yield legacyPartUpdated(event.id, event.data.sessionID, part, event.created);
          break;
        }

        case "session.tool.input.delta": {
          const key = toolKey(event.data.sessionID, event.data.id);
          const previous = state.tools.get(key);
          if (previous?.state.status === "pending") {
            const part: ToolPart = {
              ...previous,
              state: { ...previous.state, raw: previous.state.raw + event.data.delta },
            };
            state.tools.set(key, part);
            state.parts.set(part.id, part);
          }
          break;
        }

        case "session.tool.input.ended": {
          const key = toolKey(event.data.sessionID, event.data.id);
          const previous = state.tools.get(key);
          if (previous?.state.status === "pending") {
            const part: ToolPart = {
              ...previous,
              state: { ...previous.state, raw: event.data.text },
            };
            state.tools.set(key, part);
            state.parts.set(part.id, part);
          }
          break;
        }

        case "session.tool.called":
        case "session.tool.progress":
        case "session.tool.success":
        case "session.tool.failed": {
          const assistant = ensureAssistant(
            event,
            event.data.sessionID,
            event.data.assistantMessageID,
          );
          if (assistant.created) {
            yield {
              id: event.id,
              type: "message.updated",
              properties: { sessionID: event.data.sessionID, info: assistant.info },
            };
          }
          const key = toolKey(event.data.sessionID, event.data.id);
          const previous = state.tools.get(key);
          const name = previous?.tool ?? "tool";
          const previousInput = previous?.state.input ?? {};
          const started =
            previous?.state.status === "running" ||
            previous?.state.status === "completed" ||
            previous?.state.status === "error"
              ? previous.state.time.start
              : event.created;
          const base = {
            id: event.data.id,
            sessionID: event.data.sessionID,
            messageID: event.data.assistantMessageID,
            type: "tool" as const,
            callID: event.data.id,
            tool: name,
          };
          let part: ToolPart;
          if (event.type === "session.tool.called") {
            part = {
              ...base,
              state: {
                status: "running",
                input: event.data.input,
                title: name,
                time: { start: event.created },
              },
            };
          } else if (event.type === "session.tool.progress") {
            part = {
              ...base,
              state: {
                status: "running",
                input: previousInput,
                title:
                  typeof event.data.metadata.title === "string" ? event.data.metadata.title : name,
                metadata: event.data.metadata,
                time: { start: started },
              },
            };
          } else if (event.type === "session.tool.success") {
            const attachments = toolAttachments(
              event.data.content,
              event.data.sessionID,
              event.data.assistantMessageID,
              event.data.id,
            );
            part = {
              ...base,
              state: {
                status: "completed",
                input: previousInput,
                output: toolOutput(event.data.content),
                title: name,
                metadata: event.data.metadata ?? {},
                time: { start: started, end: event.created },
                ...(attachments.length > 0 ? { attachments } : {}),
              },
            };
          } else {
            part = {
              ...base,
              state: {
                status: "error",
                input: previousInput,
                error: event.data.error.message,
                ...(event.data.metadata ? { metadata: event.data.metadata } : {}),
                time: { start: started, end: event.created },
              },
            };
          }
          state.tools.set(key, part);
          state.parts.set(part.id, part);
          yield legacyPartUpdated(event.id, event.data.sessionID, part, event.created);
          break;
        }

        case "permission.asked": {
          permissionSessions.set(event.data.id, event.data.sessionID);
          const rules = permissionsBySession.get(event.data.sessionID);
          if (rules && shouldApprovePermission(rules, event.data.action, event.data.resources)) {
            approvedPermissions.add(event.data.id);
            const approved = await client.permission
              .reply({
                sessionID: event.data.sessionID,
                requestID: event.data.id,
                reply: "once",
              })
              .then(
                () => true,
                () => false,
              );
            if (approved) {
              break;
            }
            approvedPermissions.delete(event.data.id);
          }
          const properties: PermissionRequest = {
            id: event.data.id,
            sessionID: event.data.sessionID,
            permission: legacyPermissionName(event.data.action),
            patterns: event.data.resources,
            metadata: event.data.metadata ?? {},
            always: event.data.save ?? [],
            ...(event.data.source
              ? {
                  tool: {
                    messageID: event.data.source.messageID,
                    callID: event.data.source.id,
                  },
                }
              : {}),
          };
          yield { id: event.id, type: "permission.asked", properties };
          break;
        }

        case "permission.replied":
          permissionSessions.delete(event.data.requestID);
          if (approvedPermissions.delete(event.data.requestID)) {
            break;
          }
          yield {
            id: event.id,
            type: "permission.replied",
            properties: {
              sessionID: event.data.sessionID,
              requestID: event.data.requestID,
              reply: event.data.reply,
            },
          };
          break;

        case "form.created": {
          const form = event.data.form;
          forms.set(form.id, form);
          const metadataTool = form.metadata?.tool;
          const tool =
            metadataTool &&
            typeof metadataTool === "object" &&
            "messageID" in metadataTool &&
            typeof metadataTool.messageID === "string" &&
            "id" in metadataTool &&
            typeof metadataTool.id === "string"
              ? { messageID: metadataTool.messageID, callID: metadataTool.id }
              : undefined;
          yield {
            id: event.id,
            type: "question.asked",
            properties: {
              id: form.id,
              sessionID: form.sessionID,
              questions: form.fields.map((field) => toLegacyQuestion(field, form.title)),
              ...(tool ? { tool } : {}),
            },
          };
          break;
        }

        case "form.replied": {
          const form = forms.get(event.data.id);
          const answers = form
            ? form.fields.map((field) => toLegacyAnswer(field, event.data.answer[field.key]))
            : Object.values(event.data.answer).map((value) =>
                Array.isArray(value) ? value : [String(value)],
              );
          forms.delete(event.data.id);
          yield {
            id: event.id,
            type: "question.replied",
            properties: {
              sessionID: event.data.sessionID,
              requestID: event.data.id,
              answers,
            },
          };
          break;
        }

        case "form.cancelled":
          forms.delete(event.data.id);
          yield {
            id: event.id,
            type: "question.rejected",
            properties: { sessionID: event.data.sessionID, requestID: event.data.id },
          };
          break;

        default:
          break;
      }
    }
  }

  const bridge = {
    provider: {
      list: async (): Promise<{ readonly data: ProviderListResponse }> => {
        const [models, providers] = await Promise.all([
          client.model.list({ location }),
          client.provider.list({ location }),
        ]);
        const available = models.data.filter((model) => model.enabled);
        const providerModels = new Map<string, Array<ModelInfo>>();
        for (const model of available) {
          const current = providerModels.get(model.providerID) ?? [];
          current.push(model);
          providerModels.set(model.providerID, current);
        }

        const definitions = new Map(providers.data.map((provider) => [provider.id, provider]));
        for (const providerID of providerModels.keys()) {
          if (!definitions.has(providerID)) {
            definitions.set(providerID, {
              id: providerID,
              name: providerID,
              activation: "auto",
              package: "",
            });
          }
        }

        const all = [...definitions.values()].map(
          (provider): Provider => ({
            id: provider.id,
            name: provider.name,
            source: "config",
            env: [],
            options: provider.settings ?? {},
            models: Object.fromEntries(
              (providerModels.get(provider.id) ?? []).map((model) => [
                model.id,
                toLegacyModel(model, provider),
              ]),
            ),
          }),
        );
        const connected = [...definitions.values()]
          .filter(
            (provider) =>
              provider.activation !== "disabled" &&
              (providerModels.get(provider.id)?.length ?? 0) > 0,
          )
          .map((provider) => provider.id);
        const defaults = Object.fromEntries(
          connected.flatMap((providerID) => {
            const model = providerModels.get(providerID)?.[0];
            return model ? [[providerID, model.id]] : [];
          }),
        );

        return { data: { all, connected, default: defaults } };
      },
    },

    app: {
      agents: async (): Promise<{ readonly data: Array<Agent> }> => ({
        data: (await client.agent.list({ location })).data.map(toLegacyAgent),
      }),
      skills: async () => ({ data: (await client.skill.list({ location })).data }),
    },

    event: {
      subscribe: async (_parameters?: unknown, options?: LegacySubscribeOptions) => ({
        stream: translateEvents(
          client.event.subscribe(options?.signal ? { signal: options.signal } : undefined),
        ),
      }),
    },

    session: {
      create: async (parameters?: LegacySessionCreateInput) => {
        const session = await client.session.create({
          location: {
            directory: parameters?.directory ?? input.directory,
            ...(parameters?.workspaceID ? { workspaceID: parameters.workspaceID } : {}),
          },
          ...(parameters?.title ? { title: parameters.title } : {}),
          ...(parameters?.agent ? { agent: parameters.agent } : {}),
          ...(parameters?.model ? { model: parameters.model } : {}),
        });
        if (parameters?.permission) {
          permissionsBySession.set(session.id, parameters.permission);
        }
        return { data: rememberSession(session) };
      },

      get: getSession,

      update: async (parameters: LegacySessionUpdateInput) => {
        if (parameters.permission) {
          permissionsBySession.set(parameters.sessionID, parameters.permission);
        }
        if (parameters.title !== undefined) {
          await client.session.rename({
            sessionID: parameters.sessionID,
            title: parameters.title,
          });
        }
        if (parameters.title === undefined) {
          const cached = sessions.get(parameters.sessionID);
          if (cached) {
            const next: Session = {
              ...cached,
              ...(parameters.permission ? { permission: parameters.permission } : {}),
            };
            sessions.set(parameters.sessionID, next);
            return { data: next };
          }
        }
        return getSession({ sessionID: parameters.sessionID });
      },

      fork: async (parameters: LegacySessionForkInput) => {
        let session = await client.session.fork({
          sessionID: parameters.sessionID,
          boundary: parameters.messageID
            ? { type: "before", messageID: parameters.messageID }
            : { type: "through" },
        });
        const inherited = permissionsBySession.get(parameters.sessionID);
        if (inherited) {
          permissionsBySession.set(session.id, inherited);
        }
        if (parameters.directory && parameters.directory !== session.location.directory) {
          await client.session.move({ sessionID: session.id, directory: parameters.directory });
          await client.session.wait({ sessionID: session.id });
          session = await client.session.get({ sessionID: session.id });
        }
        return { data: rememberSession(session) };
      },

      promptAsync: async (parameters: LegacySessionPromptInput) => {
        await submitPrompt(parameters);
        return { data: undefined };
      },

      prompt: async (
        parameters: LegacySessionPromptInput,
      ): Promise<{ readonly data: SessionPromptResponse }> => {
        const submitted = await submitPrompt(parameters);
        await client.session.wait({ sessionID: parameters.sessionID });
        let cursor: string | undefined;
        do {
          const page = await client.message.list({
            sessionID: parameters.sessionID,
            limit: 100,
            order: "desc",
            ...(cursor ? { cursor } : {}),
          });
          const assistant = page.data.find(
            (message): message is SessionMessageAssistant => message.type === "assistant",
          );
          if (assistant) {
            const entry = toLegacyMessage(
              assistant,
              parameters.sessionID,
              sessions.get(parameters.sessionID),
              submitted.id,
            );
            if (entry.info.role === "assistant") {
              return { data: { info: entry.info, parts: entry.parts } };
            }
          }
          const next = page.cursor.next ?? undefined;
          if (!next || next === cursor) {
            break;
          }
          cursor = next;
        } while (cursor !== undefined);
        throw new Error(
          `OpenCode session '${parameters.sessionID}' completed without an assistant response.`,
        );
      },

      abort: async (parameters: LegacySessionGetInput) => {
        const result = await client.session.interrupt({ sessionID: parameters.sessionID });
        return { data: result.interrupted };
      },

      messages: listMessages,

      revert: async (parameters: LegacySessionRevertInput) => {
        const messages = await listMessages({ sessionID: parameters.sessionID });
        const targetIndex = parameters.messageID
          ? messages.data.findIndex((message) => message.info.id === parameters.messageID)
          : -1;
        if (parameters.messageID && targetIndex < 0) {
          throw new Error(`OpenCode rollback target '${parameters.messageID}' was not found.`);
        }
        const messageID = messages.data[targetIndex + 1]?.info.id;
        if (!messageID) {
          return getSession({ sessionID: parameters.sessionID });
        }

        await client.session.revert.stage({
          sessionID: parameters.sessionID,
          messageID,
          files: false,
        });
        await client.session.revert.commit({ sessionID: parameters.sessionID });
        return getSession({ sessionID: parameters.sessionID });
      },
    },

    permission: {
      reply: async (parameters: LegacyPermissionReplyInput) => {
        const sessionID = permissionSessions.get(parameters.requestID);
        if (!sessionID) {
          throw new Error(`Unknown OpenCode permission request: ${parameters.requestID}`);
        }
        await client.permission.reply({
          sessionID,
          requestID: parameters.requestID,
          reply: parameters.reply ?? "reject",
          ...(parameters.message ? { message: parameters.message } : {}),
        });
        return { data: true };
      },
    },

    question: {
      reply: async (parameters: LegacyQuestionReplyInput) => {
        const form = forms.get(parameters.requestID);
        if (!form) {
          throw new Error(`Unknown OpenCode question request: ${parameters.requestID}`);
        }
        const answer: FormAnswer = {};
        for (const [index, field] of form.fields.entries()) {
          const values = parameters.answers?.[index] ?? [];
          const converted = toFormValue(field, values);
          if (converted !== undefined) {
            answer[field.key] = converted;
          }
        }
        await client.form.reply({
          sessionID: form.sessionID,
          formID: form.id,
          answer,
        });
        return { data: true };
      },
    },

    mcp: {
      add: async (parameters: LegacyMcpAddInput) => {
        if (!parameters.name || !parameters.config) {
          throw new Error("OpenCode MCP registration requires a server name and configuration.");
        }
        await client.mcp.add({
          server: parameters.name,
          location: { directory: parameters.directory ?? input.directory },
          config: toV2McpConfig(parameters.config),
        });
        return { data: { [parameters.name]: { status: "connected" as const } } };
      },
    },
  };

  return bridge as unknown as OpencodeClient;
}

function toLegacySession(session: SessionInfo, permission?: PermissionRuleset): Session {
  return {
    id: session.id,
    slug: session.id,
    projectID: session.projectID,
    directory: session.location.directory,
    title: session.title ?? "",
    version: "2",
    time: {
      created: session.time.created,
      updated: session.time.updated,
      ...(session.time.archived !== undefined ? { archived: session.time.archived } : {}),
    },
    cost: session.cost,
    tokens: session.tokens,
    ...(session.parentID ? { parentID: session.parentID } : {}),
    ...(session.location.workspaceID ? { workspaceID: session.location.workspaceID } : {}),
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(permission ? { permission } : {}),
    ...(session.revert
      ? {
          revert: {
            messageID: session.revert.messageID,
            ...(session.revert.partID ? { partID: session.revert.partID } : {}),
            ...(session.revert.snapshot ? { snapshot: session.revert.snapshot } : {}),
          },
        }
      : {}),
  };
}

function toLegacyModel(model: ModelInfo, provider: ProviderInfo): Model {
  const cost = model.cost.find((entry) => !entry.tier) ?? model.cost[0];
  const tiers = model.cost.flatMap((entry) =>
    entry.tier
      ? [
          {
            input: entry.input,
            output: entry.output,
            cache: entry.cache,
            tier: entry.tier,
          },
        ]
      : [],
  );
  const settings: Record<string, unknown> = provider.settings ?? {};
  const baseUrl =
    typeof settings.baseURL === "string"
      ? settings.baseURL
      : typeof settings.baseUrl === "string"
        ? settings.baseUrl
        : "";
  const supports = (direction: "input" | "output", kind: string) =>
    model.capabilities[direction].includes(kind);
  const reasoningField = model.compatibility?.reasoningField;

  return {
    id: model.id,
    providerID: model.providerID,
    api: { id: model.modelID, url: baseUrl, npm: model.package ?? provider.package },
    name: model.name,
    ...(model.family ? { family: model.family } : {}),
    capabilities: {
      temperature: true,
      reasoning:
        reasoningField !== undefined ||
        supports("output", "reasoning") ||
        model.variants.length > 0,
      attachment: model.capabilities.input.some((kind) => kind !== "text"),
      toolcall: model.capabilities.tools,
      input: {
        text: supports("input", "text"),
        audio: supports("input", "audio"),
        image: supports("input", "image"),
        video: supports("input", "video"),
        pdf: supports("input", "pdf"),
      },
      output: {
        text: supports("output", "text"),
        audio: supports("output", "audio"),
        image: supports("output", "image"),
        video: supports("output", "video"),
        pdf: supports("output", "pdf"),
      },
      interleaved:
        reasoningField === "reasoning_content"
          ? { field: "reasoning_content" }
          : reasoningField === "reasoning_details"
            ? { field: "reasoning_details" }
            : false,
    },
    cost: {
      input: cost?.input ?? 0,
      output: cost?.output ?? 0,
      cache: cost?.cache ?? { read: 0, write: 0 },
      ...(tiers.length > 0 ? { tiers } : {}),
    },
    limit: model.limit,
    status: model.status,
    options: model.settings ?? {},
    headers: model.headers ?? {},
    release_date: DateTime.formatIso(DateTime.makeUnsafe(model.time.released)).slice(0, 10),
    variants: Object.fromEntries(
      model.variants.map((variant) => [
        variant.id,
        {
          ...variant.settings,
          ...(variant.headers ? { headers: variant.headers } : {}),
          ...(variant.body ? { body: variant.body } : {}),
        },
      ]),
    ),
  };
}

function toLegacyAgent(agent: AgentInfo): Agent {
  return {
    name: agent.id,
    mode: agent.mode,
    hidden: agent.hidden,
    permission: agent.permissions.map((rule) => ({
      permission: legacyPermissionName(rule.action),
      pattern: rule.resource,
      action: rule.effect,
    })),
    options: agent.request.settings,
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.color ? { color: agent.color } : {}),
    ...(agent.steps !== undefined ? { steps: agent.steps } : {}),
    ...(agent.model
      ? {
          model: { providerID: agent.model.providerID, modelID: agent.model.id },
          ...(agent.model.variant ? { variant: agent.model.variant } : {}),
        }
      : {}),
  };
}

function toLegacyMessage(
  message: Extract<SessionMessageInfo, { type: "user" | "assistant" }>,
  sessionID: string,
  session: Session | undefined,
  parentID?: string,
): LegacyMessageEntry {
  if (message.type === "user") {
    const parts: Array<Part> = [
      {
        id: contentPartId(message.id, "text", 0),
        sessionID,
        messageID: message.id,
        type: "text",
        text: message.text,
        time: { start: message.time.created },
      },
      ...(message.files ?? []).map(
        (file, index): FilePart => ({
          id: `${message.id}:file:${index}`,
          sessionID,
          messageID: message.id,
          type: "file",
          mime: file.mime,
          url:
            file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`,
          ...(file.name ? { filename: file.name } : {}),
        }),
      ),
    ];
    return { info: toLegacyUserInfo(message, sessionID, session), parts };
  }

  const directory = session?.directory ?? "";
  const info: AssistantMessage = {
    id: message.id,
    sessionID,
    role: "assistant",
    time: message.time,
    parentID: parentID ?? "",
    modelID: message.model.id,
    providerID: message.model.providerID,
    mode: message.agent,
    agent: message.agent,
    path: { cwd: directory, root: directory },
    cost: message.cost ?? 0,
    tokens: message.tokens ?? { ...EMPTY_TOKENS, cache: { ...EMPTY_TOKENS.cache } },
    ...(message.model.variant ? { variant: message.model.variant } : {}),
    ...(message.finish ? { finish: message.finish } : {}),
    ...(message.error ? { error: toLegacyError(message.error, message.model) } : {}),
  };
  const parts = message.content.map((content, ordinal): Part => {
    if (content.type === "tool") {
      return toLegacyTool(content, message, sessionID);
    }
    const start =
      content.type === "reasoning"
        ? (content.time?.created ?? message.time.created)
        : message.time.created;
    const end =
      content.type === "reasoning"
        ? (content.time?.completed ?? message.time.completed)
        : message.time.completed;
    return {
      id: contentPartId(message.id, content.type, ordinal),
      sessionID,
      messageID: message.id,
      type: content.type,
      text: content.text,
      time: { start, ...(end !== undefined ? { end } : {}) },
    };
  });
  return { info, parts };
}

function toLegacyUserInfo(
  message: { readonly id: string; readonly time: { readonly created: number } },
  sessionID: string,
  session: Session | undefined,
): UserMessage {
  return {
    id: message.id,
    sessionID,
    role: "user",
    time: { created: message.time.created },
    agent: session?.agent ?? "",
    model: {
      providerID: session?.model?.providerID ?? "",
      modelID: session?.model?.id ?? "",
      ...(session?.model?.variant ? { variant: session.model.variant } : {}),
    },
  };
}

function toLegacyTool(
  tool: SessionMessageAssistantTool,
  message: SessionMessageAssistant,
  sessionID: string,
): ToolPart {
  const name = legacyPermissionName(tool.name);
  const base = {
    id: tool.id,
    sessionID,
    messageID: message.id,
    type: "tool" as const,
    callID: tool.id,
    tool: name,
  };
  const start = tool.time.ran ?? tool.time.created;
  switch (tool.state.status) {
    case "streaming":
      return {
        ...base,
        state: { status: "pending", input: {}, raw: tool.state.input },
      };
    case "running":
      return {
        ...base,
        state: {
          status: "running",
          input: tool.state.input,
          title: name,
          metadata: tool.state.metadata,
          time: { start },
        },
      };
    case "completed": {
      const attachments = toolAttachments(tool.state.content, sessionID, message.id, tool.id);
      return {
        ...base,
        state: {
          status: "completed",
          input: tool.state.input,
          output: toolOutput(tool.state.content),
          title: name,
          metadata: tool.state.metadata ?? {},
          time: {
            start,
            end: tool.time.completed ?? message.time.completed ?? start,
          },
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      };
    }
    case "error":
      return {
        ...base,
        state: {
          status: "error",
          input: tool.state.input,
          error: tool.state.error.message,
          ...(tool.state.metadata ? { metadata: tool.state.metadata } : {}),
          time: {
            start,
            end: tool.time.completed ?? message.time.completed ?? start,
          },
        },
      };
  }
}

function toLegacyError(
  error: SessionStructuredError,
  model?: ModelRef,
): NonNullable<AssistantMessage["error"]> {
  if (error.type === "provider.auth") {
    return {
      name: "ProviderAuthError",
      data: { providerID: model?.providerID ?? "", message: error.message },
    };
  }
  if (error.type === "aborted") {
    return { name: "MessageAbortedError", data: { message: error.message } };
  }
  if (error.status !== undefined) {
    return {
      name: "APIError",
      data: { message: error.message, statusCode: error.status, isRetryable: false },
    };
  }
  return { name: "UnknownError", data: { message: error.message } };
}

function legacySessionStatus(
  id: string,
  sessionID: string,
  status: Extract<Event, { type: "session.status" }>["properties"]["status"],
): Extract<Event, { type: "session.status" }> {
  return { id, type: "session.status", properties: { sessionID, status } };
}

function legacyPartUpdated(
  id: string,
  sessionID: string,
  part: Part,
  time: number,
): Extract<Event, { type: "message.part.updated" }> {
  return { id, type: "message.part.updated", properties: { sessionID, part, time } };
}

function contentPartId(messageID: string, type: "text" | "reasoning", ordinal: number): string {
  return `${messageID}:${type}:${ordinal}`;
}

function toolKey(sessionID: string, id: string): string {
  return `${sessionID}:${id}`;
}

function eventTimestamp(event: OpenCodeEvent): number {
  return "created" in event ? event.created : 0;
}

function toolOutput(content: ReadonlyArray<ToolContent | ToolContent1>): string {
  return content.map((entry) => (entry.type === "text" ? entry.text : entry.uri)).join("\n");
}

function toolAttachments(
  content: ReadonlyArray<ToolContent | ToolContent1>,
  sessionID: string,
  messageID: string,
  toolID: string,
): Array<FilePart> {
  return content.flatMap(
    (entry, index): Array<FilePart> =>
      entry.type === "file"
        ? [
            {
              id: `${toolID}:file:${index}`,
              sessionID,
              messageID,
              type: "file",
              mime: entry.mime,
              url: entry.uri,
              ...(entry.name ? { filename: entry.name } : {}),
            },
          ]
        : [],
  );
}

function legacyPermissionName(action: string): string {
  return action === "shell" ? "bash" : action;
}

function shouldApprovePermission(
  rules: PermissionRuleset,
  action: string,
  resources: ReadonlyArray<string>,
): boolean {
  if (resources.length === 0) {
    return false;
  }
  const permission = legacyPermissionName(action);
  return resources.every((resource) => {
    const matching = rules.findLast(
      (rule) =>
        matchesWildcard(permission, rule.permission) && matchesWildcard(resource, rule.pattern),
    );
    return matching?.action === "allow";
  });
}

function matchesWildcard(value: string, pattern: string): boolean {
  if (pattern === "*") {
    return true;
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

function toLegacyQuestion(field: FormField1, title: string): QuestionInfo {
  const options =
    field.type === "boolean"
      ? [
          { label: "Yes", description: "Yes" },
          { label: "No", description: "No" },
        ]
      : field.type === "external"
        ? [{ label: "Acknowledge", description: field.url }]
        : "options" in field
          ? (field.options ?? []).map((option) => ({
              label: option.label,
              description: option.description ?? "",
            }))
          : [];
  return {
    header: field.title ?? field.key,
    question: field.description ?? field.title ?? title,
    options,
    ...(field.type === "multiselect" ? { multiple: true } : {}),
    ...("custom" in field && field.custom !== undefined ? { custom: field.custom } : {}),
  };
}

function toLegacyAnswer(field: FormField1, value: FormAnswer[string] | undefined): QuestionAnswer {
  if (value === undefined) {
    return [];
  }
  const values = Array.isArray(value) ? value : [String(value)];
  if (!("options" in field)) {
    return values;
  }
  return values.map(
    (entry) => field.options?.find((option) => option.value === entry)?.label ?? entry,
  );
}

function toFormValue(field: FormField1, values: QuestionAnswer): FormAnswer[string] | undefined {
  if (field.type === "external") {
    return true;
  }
  if (values.length === 0) {
    return field.type === "multiselect" ? [] : undefined;
  }
  const first = values[0];
  if (first === undefined) {
    return undefined;
  }
  if (field.type === "boolean") {
    return first.toLowerCase() === "yes" || first.toLowerCase() === "true";
  }
  if (field.type === "number" || field.type === "integer") {
    const number = Number(first);
    return Number.isFinite(number) ? number : undefined;
  }
  const converted = values.map(
    (value) => field.options?.find((option) => option.label === value)?.value ?? value,
  );
  return field.type === "multiselect" ? converted : converted[0];
}

function toV2McpConfig(
  config: NonNullable<LegacyMcpAddInput["config"]>,
): Parameters<V2Client["mcp"]["add"]>[0]["config"] {
  const timeout =
    config.timeout === undefined
      ? {}
      : {
          timeout: {
            startup: config.timeout,
            catalog: config.timeout,
            execution: config.timeout,
          },
        };
  const enabled = config.enabled === undefined ? {} : { disabled: !config.enabled };

  if (config.type === "local") {
    return {
      type: "local",
      command: config.command,
      ...(config.environment ? { environment: config.environment } : {}),
      ...enabled,
      ...timeout,
    };
  }

  const oauth =
    config.oauth === false
      ? { oauth: false as const }
      : config.oauth
        ? {
            oauth: {
              ...(config.oauth.clientId ? { client_id: config.oauth.clientId } : {}),
              ...(config.oauth.clientSecret ? { client_secret: config.oauth.clientSecret } : {}),
              ...(config.oauth.scope ? { scope: config.oauth.scope } : {}),
              ...(config.oauth.callbackPort !== undefined
                ? { callback_port: config.oauth.callbackPort }
                : {}),
              ...(config.oauth.redirectUri ? { redirect_uri: config.oauth.redirectUri } : {}),
            },
          }
        : {};
  return {
    type: "remote",
    url: config.url,
    ...(config.headers ? { headers: config.headers } : {}),
    ...oauth,
    ...enabled,
    ...timeout,
  };
}
