import type {
  Agent,
  Command,
  Event as LegacyEvent,
  OpencodeClient,
  Part,
  PermissionRequest as LegacyPermissionRequest,
  ProviderListResponse,
  QuestionRequest as LegacyQuestionRequest,
} from "@opencode-ai/sdk/v2";
import type {
  FormInfo,
  PermissionRequest as NextPermissionRequest,
  SessionMessageInfo,
  V2Event,
} from "@opencode/client";

import type { OpenCodeNextClient } from "./opencodeRuntime.ts";

/**
 * Presents the legacy `@opencode-ai/sdk/v2` client surface that the OpenCode
 * adapter consumes, backed by an OpenCode 2 `@opencode/client`. The adapter
 * speaks the legacy protocol end to end; this module is the only place that
 * knows the V2 `/api` shape.
 *
 * The mapping is intentionally lossy where V2 changed semantics:
 * - model/agent/reasoning are session state in V2, applied with
 *   `session.switchModel`/`session.switchAgent` before a prompt;
 * - the T3 runtime instructions ride as a prefix on the prompt text; V2 has no
 *   `system` field, and its instruction-entry API blocked instruction init;
 * - questions are OpenCode 2 forms, permissions use the V2 ruleset shape;
 * - fork-to-directory has no V2 equivalent and degrades to `session.move`.
 */

type LegacyEventOf<T extends LegacyEvent["type"]> = Extract<LegacyEvent, { type: T }>;

function trimText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textFromToolContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts: Array<string> = [];
  for (const entry of content) {
    if (isRecord(entry) && entry.type === "text" && typeof entry.text === "string") {
      texts.push(entry.text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Legacy permissions are `{permission, pattern, action}`; V2 is `{action, resource, effect}`. */
function toNextPermissions(
  rules: ReadonlyArray<{
    readonly permission: string;
    readonly pattern: string;
    readonly action: string;
  }>,
): Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> {
  return rules.map((rule) => ({
    action: rule.permission,
    resource: rule.pattern,
    effect: rule.action === "allow" ? "allow" : rule.action === "deny" ? "deny" : "ask",
  }));
}

function toLegacyPermission(request: NextPermissionRequest): LegacyPermissionRequest {
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.action,
    patterns: request.resources,
    ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
  } as unknown as LegacyPermissionRequest;
}

function toLegacyQuestion(form: FormInfo): LegacyQuestionRequest {
  const fields = (form.fields ?? []) as ReadonlyArray<{
    readonly key: string;
    readonly title?: string;
    readonly type?: string;
    readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  }>;
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: fields.map((field) => ({
      header: field.title ?? field.key,
      question: field.title ?? field.key,
      options: (field.options ?? []).map((option) => ({
        label: option.label,
        value: option.value,
      })),
      multiSelect: field.type === "multiselect",
    })),
  } as unknown as LegacyQuestionRequest;
}

function toNextFormAnswer(
  fields: ReadonlyArray<{ readonly key: string }>,
  answers: ReadonlyArray<string>,
): Record<string, string | Array<string>> {
  const answer: Record<string, string | Array<string>> = {};
  fields.forEach((field, index) => {
    const value = answers[index];
    if (value !== undefined && value.length > 0) answer[field.key] = value;
  });
  return answer;
}

export interface NextProviderSummary {
  readonly id: string;
  readonly name: string;
}

export interface NextModelSummary {
  readonly modelID: string;
  readonly providerID: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly variants: ReadonlyArray<{ readonly id: string }>;
}

/**
 * OpenCode 2 warms its provider list asynchronously: right after startup
 * `provider.list` can be empty while `model.list` already reflects the
 * configured providers. Derive the connected set from both so the model
 * inventory is populated immediately.
 */
export function buildNextProviderList(
  providers: ReadonlyArray<NextProviderSummary>,
  models: ReadonlyArray<NextModelSummary>,
): { all: ProviderListResponse["all"]; connected: string[] } {
  const meta = new Map(providers.map((provider) => [provider.id, provider]));
  const connected = providers.map((provider) => provider.id);
  const seen = new Set(connected);
  const modelsByProvider = new Map<string, Record<string, unknown>>();
  for (const model of models) {
    if (!model.enabled) continue;
    if (!seen.has(model.providerID)) {
      seen.add(model.providerID);
      connected.push(model.providerID);
    }
    const bucket = modelsByProvider.get(model.providerID) ?? {};
    bucket[model.modelID] = {
      id: model.modelID,
      providerID: model.providerID,
      name: model.name,
      variants: Object.fromEntries(model.variants.map((variant) => [variant.id, {}])),
    };
    modelsByProvider.set(model.providerID, bucket);
  }
  const all = connected.map((id) => ({
    id,
    name: meta.get(id)?.name ?? id,
    source: "config" as const,
    env: [] as Array<string>,
    options: {} as Record<string, unknown>,
    models: (modelsByProvider.get(id) ?? {}) as ProviderListResponse["all"][number]["models"],
  }));
  return { all, connected };
}

interface TextPartState {
  readonly kind: "text" | "reasoning";
  readonly messageID: string;
  readonly partID: string;
  text: string;
  readonly start: number;
  end?: number;
}

interface ToolState {
  readonly messageID: string;
  readonly callID: string;
  name: string;
  input: Record<string, unknown>;
  inputText: string;
  title?: string;
  status: "pending" | "running" | "completed" | "error";
  output?: string;
  error?: string;
  start: number;
  end?: number;
}

interface CompatState {
  readonly assistantMessagesSeen: Set<string>;
  readonly textParts: Map<string, TextPartState>;
  readonly tools: Map<string, ToolState>;
  readonly lastUserMessageID: Map<string, string>;
  readonly permissionSessions: Map<string, string>;
  readonly formSessions: Map<string, FormInfo>;
  readonly switchedModel: Map<string, string>;
  readonly switchedAgent: Map<string, string>;
}

function partKey(messageID: string, kind: string, ordinal: number): string {
  return `${messageID}:${kind}:${ordinal}`;
}

export interface OpenCodeCompatClientInput {
  readonly client: OpenCodeNextClient;
  readonly directory: string;
  readonly onSseError?: (error: unknown) => void;
}

/**
 * Builds a legacy-shaped OpenCode client over the V2 `@opencode/client`.
 * Returned methods cover exactly the surface the adapter, driver and text
 * generation call; the result is cast to the legacy client type at the seam.
 */
export function createOpenCodeCompatClient(input: OpenCodeCompatClientInput): OpencodeClient {
  const { client, directory } = input;
  const location = { location: { directory } };
  const locationRef = { directory };
  const state: CompatState = {
    assistantMessagesSeen: new Set(),
    textParts: new Map(),
    tools: new Map(),
    lastUserMessageID: new Map(),
    permissionSessions: new Map(),
    formSessions: new Map(),
    switchedModel: new Map(),
    switchedAgent: new Map(),
  };

  type Synthetic = LegacyEvent;
  const queue: Array<Synthetic> = [];
  const waiters: Array<(event: Synthetic | undefined) => void> = [];
  let closed = false;
  const push = (event: Synthetic) => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else queue.push(event);
  };
  const closeQueue = () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()?.(undefined);
  };
  const nextQueued = (): Promise<Synthetic | undefined> => {
    const queued = queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (closed) return Promise.resolve(undefined);
    return new Promise((resolve) => waiters.push(resolve));
  };

  const ensureAssistantMessage = (sessionID: string, messageID: string): Array<LegacyEvent> => {
    if (state.assistantMessagesSeen.has(messageID)) return [];
    state.assistantMessagesSeen.add(messageID);
    const parentID = state.lastUserMessageID.get(sessionID);
    return [
      {
        type: "message.updated",
        properties: {
          sessionID,
          info: {
            id: messageID,
            role: "assistant",
            ...(parentID !== undefined ? { parentID } : {}),
          },
        },
      } as unknown as LegacyEventOf<"message.updated">,
    ];
  };

  const emitTextPart = (
    part: TextPartState,
    messageID: string,
    sessionID: string,
  ): Array<LegacyEvent> => [
    ...ensureAssistantMessage(sessionID, messageID),
    {
      type: "message.part.updated",
      properties: {
        sessionID,
        part: {
          type: part.kind,
          id: part.partID,
          messageID: part.messageID,
          sessionID,
          text: part.text,
          time: { start: part.start, ...(part.end !== undefined ? { end: part.end } : {}) },
        },
      },
    } as unknown as LegacyEventOf<"message.part.updated">,
  ];

  const emitToolPart = (tool: ToolState, sessionID: string): Array<LegacyEvent> => [
    ...ensureAssistantMessage(sessionID, tool.messageID),
    {
      type: "message.part.updated",
      properties: {
        sessionID,
        part: {
          type: "tool",
          id: tool.callID,
          callID: tool.callID,
          messageID: tool.messageID,
          sessionID,
          tool: tool.name,
          state: {
            status: tool.status,
            input: tool.input,
            ...(tool.title !== undefined ? { title: tool.title } : {}),
            ...(tool.output !== undefined ? { output: tool.output } : {}),
            ...(tool.error !== undefined ? { error: tool.error } : {}),
            time: { start: tool.start, ...(tool.end !== undefined ? { end: tool.end } : {}) },
          },
        },
      },
    } as unknown as LegacyEventOf<"message.part.updated">,
  ];

  const translate = (event: V2Event): Array<LegacyEvent> => {
    switch (event.type) {
      case "server.connected":
        return [
          {
            type: "server.connected",
            properties: {},
          } as unknown as LegacyEventOf<"server.connected">,
        ];

      case "session.created":
        return [
          {
            type: "session.created",
            properties: {
              info: {
                id: event.data.sessionID,
                ...(event.data.parentID !== undefined ? { parentID: event.data.parentID } : {}),
                ...(event.data.title !== undefined ? { title: event.data.title } : {}),
              },
            },
          } as unknown as LegacyEventOf<"session.created">,
        ];

      case "session.renamed":
        return [
          {
            type: "session.updated",
            properties: { info: { id: event.data.sessionID, title: event.data.title } },
          } as unknown as LegacyEventOf<"session.updated">,
        ];

      case "session.metadata.updated": {
        const title = trimText((event.data.metadata as { title?: unknown } | undefined)?.title);
        return title === undefined
          ? []
          : [
              {
                type: "session.updated",
                properties: { info: { id: event.data.sessionID, title } },
              } as unknown as LegacyEventOf<"session.updated">,
            ];
      }

      case "session.deleted":
        return [
          {
            type: "session.deleted",
            properties: { info: { id: event.data.sessionID } },
          } as unknown as LegacyEventOf<"session.deleted">,
        ];

      case "session.forked":
        return [
          {
            type: "session.created",
            properties: { info: { id: event.data.sessionID, parentID: event.data.parentID } },
          } as unknown as LegacyEventOf<"session.created">,
        ];

      case "session.status":
        return [
          {
            type: "session.status",
            properties: { sessionID: event.data.sessionID, status: event.data.status },
          } as unknown as LegacyEventOf<"session.status">,
        ];

      case "session.idle":
        return [
          {
            type: "session.status",
            properties: { sessionID: event.data.sessionID, status: { type: "idle" } },
          } as unknown as LegacyEventOf<"session.status">,
        ];

      case "session.execution.started":
        return [
          {
            type: "session.status",
            properties: { sessionID: event.data.sessionID, status: { type: "busy" } },
          } as unknown as LegacyEventOf<"session.status">,
        ];

      case "session.execution.succeeded":
        return [
          {
            type: "session.status",
            properties: { sessionID: event.data.sessionID, status: { type: "idle" } },
          } as unknown as LegacyEventOf<"session.status">,
        ];

      case "session.execution.interrupted":
        return [
          {
            type: "session.status",
            properties: { sessionID: event.data.sessionID, status: { type: "idle" } },
          } as unknown as LegacyEventOf<"session.status">,
          {
            type: "session.error",
            properties: {
              sessionID: event.data.sessionID,
              error: { name: "MessageAbortedError", data: { message: event.data.reason } },
            },
          } as unknown as LegacyEventOf<"session.error">,
        ];

      case "session.execution.failed":
        return [
          {
            type: "session.status",
            properties: { sessionID: event.data.sessionID, status: { type: "idle" } },
          } as unknown as LegacyEventOf<"session.status">,
          {
            type: "session.error",
            properties: {
              sessionID: event.data.sessionID,
              error: { name: "ProviderError", data: { message: event.data.error.message } },
            },
          } as unknown as LegacyEventOf<"session.error">,
        ];

      case "session.retry.scheduled":
        return [
          {
            type: "session.status",
            properties: {
              sessionID: event.data.sessionID,
              status: {
                type: "retry",
                attempt: event.data.attempt,
                message: event.data.error.message,
              },
            },
          } as unknown as LegacyEventOf<"session.status">,
        ];

      case "session.text.started":
      case "session.reasoning.started": {
        const kind = event.type === "session.text.started" ? "text" : "reasoning";
        const key = partKey(event.data.assistantMessageID, kind, event.data.ordinal);
        const part: TextPartState = {
          kind,
          messageID: event.data.assistantMessageID,
          partID: key,
          text: "",
          start: event.created,
        };
        state.textParts.set(key, part);
        return emitTextPart(part, event.data.assistantMessageID, event.data.sessionID);
      }

      case "session.text.delta":
      case "session.reasoning.delta": {
        const kind = event.type === "session.text.delta" ? "text" : "reasoning";
        const key = partKey(event.data.assistantMessageID, kind, event.data.ordinal);
        const part = state.textParts.get(key);
        if (part === undefined) return [];
        part.text += event.data.delta;
        return emitTextPart(part, event.data.assistantMessageID, event.data.sessionID);
      }

      case "session.text.ended":
      case "session.reasoning.ended": {
        const kind = event.type === "session.text.ended" ? "text" : "reasoning";
        const key = partKey(event.data.assistantMessageID, kind, event.data.ordinal);
        const part = state.textParts.get(key);
        if (part === undefined) return [];
        part.text = event.data.text;
        part.end = event.created;
        return emitTextPart(part, event.data.assistantMessageID, event.data.sessionID);
      }

      case "session.step.ended": {
        const usage = event.data.tokens;
        return [
          ...ensureAssistantMessage(event.data.sessionID, event.data.assistantMessageID),
          {
            type: "message.part.updated",
            properties: {
              sessionID: event.data.sessionID,
              part: {
                type: "step-finish",
                id: `${event.data.assistantMessageID}:step:${event.id}`,
                messageID: event.data.assistantMessageID,
                sessionID: event.data.sessionID,
                tokens: {
                  input: usage.input,
                  output: usage.output,
                  reasoning: usage.reasoning,
                  cache: { read: usage.cache.read, write: usage.cache.write },
                },
              },
            },
          } as unknown as LegacyEventOf<"message.part.updated">,
        ];
      }

      case "session.step.failed":
        return [
          {
            type: "session.error",
            properties: {
              sessionID: event.data.sessionID,
              error: { name: "ProviderError", data: { message: event.data.error.message } },
            },
          } as unknown as LegacyEventOf<"session.error">,
        ];

      case "session.tool.input.started": {
        const tool: ToolState = {
          messageID: event.data.assistantMessageID,
          callID: event.data.id,
          name: event.data.name,
          input: {},
          inputText: "",
          status: "pending",
          start: event.created,
        };
        state.tools.set(event.data.id, tool);
        return emitToolPart(tool, event.data.sessionID);
      }

      case "session.tool.input.delta": {
        const tool = state.tools.get(event.data.id);
        if (tool === undefined) return [];
        tool.inputText += event.data.delta;
        return [];
      }

      case "session.tool.input.ended": {
        const tool = state.tools.get(event.data.id);
        if (tool === undefined) return [];
        tool.inputText = event.data.text;
        try {
          const parsed: unknown = JSON.parse(event.data.text);
          if (isRecord(parsed)) tool.input = parsed;
        } catch {
          // Tool input may not be valid JSON yet; keep the last parsed value.
        }
        tool.status = "running";
        return emitToolPart(tool, event.data.sessionID);
      }

      case "session.tool.called": {
        const tool = state.tools.get(event.data.id);
        if (tool === undefined) return [];
        tool.input = event.data.input;
        tool.status = "running";
        return emitToolPart(tool, event.data.sessionID);
      }

      case "session.tool.progress": {
        const tool = state.tools.get(event.data.id);
        if (tool === undefined) return [];
        const title = trimText(event.data.metadata.title);
        if (title !== undefined) tool.title = title;
        return emitToolPart(tool, event.data.sessionID);
      }

      case "session.tool.success": {
        const tool = state.tools.get(event.data.id);
        if (tool === undefined) return [];
        tool.status = "completed";
        const output = textFromToolContent(event.data.content);
        if (output !== undefined) tool.output = output;
        tool.end = event.created;
        return emitToolPart(tool, event.data.sessionID);
      }

      case "session.tool.failed": {
        const tool = state.tools.get(event.data.id);
        if (tool === undefined) return [];
        tool.status = "error";
        tool.error = event.data.error.message;
        tool.end = event.created;
        return emitToolPart(tool, event.data.sessionID);
      }

      case "session.compaction.ended":
        return [
          {
            type: "session.compacted",
            properties: { sessionID: event.data.sessionID },
          } as unknown as LegacyEventOf<"session.compacted">,
        ];

      case "permission.asked": {
        state.permissionSessions.set(event.data.id, event.data.sessionID);
        return [
          {
            type: "permission.asked",
            properties: toLegacyPermission({
              id: event.data.id,
              sessionID: event.data.sessionID,
              action: event.data.action,
              resources: event.data.resources,
              ...(event.data.metadata !== undefined ? { metadata: event.data.metadata } : {}),
            }),
          } as unknown as LegacyEventOf<"permission.asked">,
        ];
      }

      case "permission.replied":
        return [
          {
            type: "permission.replied",
            properties: {
              sessionID: event.data.sessionID,
              requestID: event.data.requestID,
              reply: event.data.reply,
            },
          } as unknown as LegacyEventOf<"permission.replied">,
        ];

      case "form.created":
        state.formSessions.set(event.data.form.id, event.data.form);
        return [
          {
            type: "question.asked",
            properties: toLegacyQuestion(event.data.form),
          } as unknown as LegacyEventOf<"question.asked">,
        ];

      case "form.replied":
        return [
          {
            type: "question.replied",
            properties: {
              sessionID: event.data.sessionID,
              requestID: event.data.id,
              answers: event.data.answer,
            },
          } as unknown as LegacyEventOf<"question.replied">,
        ];

      case "form.cancelled":
        return [
          {
            type: "question.rejected",
            properties: { sessionID: event.data.sessionID, requestID: event.data.id },
          } as unknown as LegacyEventOf<"question.rejected">,
        ];

      default:
        return [];
    }
  };

  const applySessionState = async (
    sessionID: string,
    model: { providerID: string; modelID: string; variant?: string } | undefined,
    agent: string | undefined,
  ): Promise<void> => {
    if (model !== undefined) {
      const key = `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`;
      if (state.switchedModel.get(sessionID) !== key) {
        await client.session.switchModel({
          sessionID,
          model: {
            id: model.modelID,
            providerID: model.providerID,
            ...(model.variant !== undefined ? { variant: model.variant } : {}),
          },
        });
        state.switchedModel.set(sessionID, key);
      }
    }
    if (agent !== undefined && state.switchedAgent.get(sessionID) !== agent) {
      await client.session.switchAgent({ sessionID, agent });
      state.switchedAgent.set(sessionID, agent);
    }
  };

  const toParts = (message: SessionMessageInfo): Array<Part> => {
    if (message.type !== "assistant") return [];
    const content = message.content ?? [];
    const parts: Array<Part> = [];
    content.forEach((entry, index) => {
      if (entry.type === "text") {
        parts.push({
          type: "text",
          id: `${message.id}:text:${index}`,
          messageID: message.id,
          text: entry.text,
          time: {
            start: message.time.created,
            ...(message.time.completed !== undefined ? { end: message.time.completed } : {}),
          },
        } as unknown as Part);
      } else if (entry.type === "reasoning") {
        parts.push({
          type: "reasoning",
          id: `${message.id}:reasoning:${index}`,
          messageID: message.id,
          text: entry.text,
          time:
            entry.time?.created !== undefined
              ? {
                  start: entry.time.created,
                  ...(entry.time.completed !== undefined ? { end: entry.time.completed } : {}),
                }
              : undefined,
        } as unknown as Part);
      } else if (entry.type === "tool") {
        const toolState = entry.state;
        parts.push({
          type: "tool",
          id: entry.id,
          callID: entry.id,
          messageID: message.id,
          tool: entry.name,
          state: {
            status:
              toolState.status === "completed"
                ? "completed"
                : toolState.status === "error"
                  ? "error"
                  : toolState.status === "streaming"
                    ? "pending"
                    : "running",
            input: "input" in toolState ? toolState.input : {},
            ...("content" in toolState ? { output: textFromToolContent(toolState.content) } : {}),
            ...(toolState.status === "error" ? { error: toolState.error.message } : {}),
            time: {
              start: entry.time.created,
              ...(entry.time.completed !== undefined ? { end: entry.time.completed } : {}),
            },
          },
        } as unknown as Part);
      }
    });
    return parts;
  };

  const toLegacySessionMessages = (messages: ReadonlyArray<SessionMessageInfo>) =>
    messages.map((message) => ({
      info: {
        id: message.id,
        role: message.type === "assistant" ? "assistant" : "user",
      },
      parts: toParts(message),
    }));

  const compat = {
    global: {
      health: async () => {
        const info = await client.server.info();
        return { data: { healthy: true as const, version: info.version } };
      },
    },
    provider: {
      list: async () => {
        const [providers, models] = await Promise.all([
          client.provider.list(location),
          client.model.list(location),
        ]);
        const { all, connected } = buildNextProviderList(providers.data, models.data);
        return { data: { all, connected, default: {} } };
      },
    },
    app: {
      agents: async () => ({
        data: (await client.agent.list(location)).data.map(
          (agent): Agent =>
            ({
              name: agent.id,
              mode: agent.mode,
              hidden: agent.hidden,
              permission: agent.permissions,
              options: {},
            }) as unknown as Agent,
        ),
      }),
      skills: async () => ({
        data: (await client.skill.list(location)).data.map((skill) => ({
          name: skill.name,
          ...(skill.description === undefined ? {} : { description: skill.description }),
          location: skill.path,
        })),
      }),
    },
    command: {
      list: async (): Promise<{ data: Array<Command> }> => ({
        data: (await client.command.list(location)).data.map(
          (command) =>
            ({
              name: command.name,
              ...(command.description === undefined ? {} : { description: command.description }),
              hints: [],
            }) as unknown as Command,
        ),
      }),
    },
    mcp: {
      add: async (input: { name: string; config: unknown }) => {
        await client.mcp.add({
          server: input.name,
          location: locationRef,
          config: input.config as never,
        });
        return { data: {} };
      },
    },
    session: {
      create: async (input: {
        title?: string;
        permission?: ReadonlyArray<{ permission: string; pattern: string; action: string }>;
      }) => {
        const session = await client.session.create({
          ...(input.title !== undefined ? { title: input.title } : {}),
          location: locationRef,
          ...(input.permission !== undefined
            ? { permissions: toNextPermissions(input.permission) }
            : {}),
        });
        return { data: toLegacySession(session) };
      },
      get: async (input: { sessionID: string }) => {
        const session = await client.session.get({ sessionID: input.sessionID });
        return { data: toLegacySession(session) };
      },
      update: async (input: {
        sessionID: string;
        permission?: ReadonlyArray<{ permission: string; pattern: string; action: string }>;
      }) => {
        await client.session.update({
          sessionID: input.sessionID,
          ...(input.permission !== undefined
            ? { permissions: toNextPermissions(input.permission) }
            : {}),
        });
        return { data: {} };
      },
      fork: async (input: { sessionID: string; messageID?: string; directory?: string }) => {
        if (input.messageID !== undefined) {
          const forked = await client.session.fork({
            sessionID: input.sessionID,
            before: input.messageID,
          });
          return { data: toLegacySession(forked) };
        }
        if (input.directory !== undefined && input.directory !== directory) {
          await client.session.move({ sessionID: input.sessionID, directory: input.directory });
        }
        const session = await client.session.get({ sessionID: input.sessionID });
        return { data: toLegacySession(session) };
      },
      abort: async (input: { sessionID: string }) => {
        await client.session.interrupt({ sessionID: input.sessionID });
        return { data: {} };
      },
      children: async (input: { sessionID: string }) => {
        const sessions = await client.session.list({ directory, parentID: input.sessionID });
        return { data: sessions.data.map((session) => ({ id: session.id })) };
      },
      status: async () => {
        const active = await client.session.active();
        return {
          data: Object.fromEntries(
            Object.keys(active).map((sessionID) => [sessionID, { type: "busy" as const }]),
          ),
        };
      },
      command: async (input: {
        sessionID: string;
        messageID?: string;
        command: string;
        arguments?: string;
        model?: { providerID: string; modelID: string };
        agent?: string;
        variant?: string;
        parts?: ReadonlyArray<{
          type: string;
          text?: string;
          mime?: string;
          filename?: string;
          url?: string;
        }>;
      }) => {
        await applySessionState(
          input.sessionID,
          input.model !== undefined
            ? {
                providerID: input.model.providerID,
                modelID: input.model.modelID,
                ...(input.variant !== undefined ? { variant: input.variant } : {}),
              }
            : undefined,
          input.agent,
        );
        const text = (input.parts ?? [])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("\n");
        const files = (input.parts ?? [])
          .filter((part) => part.type === "file" && typeof part.url === "string")
          .map((part) => ({
            uri: part.url as string,
            ...(part.filename !== undefined ? { name: part.filename } : {}),
          }));
        await client.session.command({
          sessionID: input.sessionID,
          name: input.command,
          text: input.arguments ?? text,
          ...(files.length > 0 ? { files } : {}),
        });
        if (input.messageID !== undefined) {
          state.lastUserMessageID.set(input.sessionID, input.messageID);
          push({
            type: "message.updated",
            properties: { sessionID: input.sessionID, info: { id: input.messageID, role: "user" } },
          } as unknown as LegacyEvent);
        }
        return { data: {} };
      },
      promptAsync: async (input: {
        sessionID: string;
        messageID?: string;
        model?: { providerID: string; modelID: string };
        agent?: string;
        variant?: string;
        system?: string;
        parts?: ReadonlyArray<{
          type: string;
          text?: string;
          mime?: string;
          filename?: string;
          url?: string;
        }>;
      }) => {
        await applySessionState(
          input.sessionID,
          input.model !== undefined
            ? {
                providerID: input.model.providerID,
                modelID: input.model.modelID,
                ...(input.variant !== undefined ? { variant: input.variant } : {}),
              }
            : undefined,
          input.agent,
        );
        const bodyText = (input.parts ?? [])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("\n");
        // OpenCode 2 has no `system` field on `session.prompt`, and its
        // experimental instruction-entry API blocked instruction initialization
        // ("Instruction initialization blocked by unavailable sources"), so the
        // T3 runtime instructions ride as a prefix on the prompt text instead.
        const system = input.system?.trim();
        const text = system && system.length > 0 ? `${system}\n\n${bodyText}` : bodyText;
        const files = (input.parts ?? [])
          .filter((part) => part.type === "file" && typeof part.url === "string")
          .map((part) => ({
            uri: part.url as string,
            ...(part.filename !== undefined ? { name: part.filename } : {}),
          }));
        await client.session.prompt({
          sessionID: input.sessionID,
          ...(input.messageID !== undefined ? { id: input.messageID } : {}),
          text,
          ...(files.length > 0 ? { files } : {}),
        });
        if (input.messageID !== undefined) {
          state.lastUserMessageID.set(input.sessionID, input.messageID);
          push({
            type: "message.updated",
            properties: { sessionID: input.sessionID, info: { id: input.messageID, role: "user" } },
          } as unknown as LegacyEvent);
        }
        return { data: {} };
      },
      summarize: async (input: { sessionID: string }) => {
        await client.session.compact({ sessionID: input.sessionID });
        return { data: {} };
      },
      messages: async (input: { sessionID: string }) => {
        const messages = await client.session.context({ sessionID: input.sessionID });
        return { data: toLegacySessionMessages(messages) };
      },
      message: async (input: { sessionID: string; messageID: string }) => {
        const message = await client.session.message.get({
          sessionID: input.sessionID,
          messageID: input.messageID,
        });
        return {
          data: {
            info: { id: message.id, role: message.type === "assistant" ? "assistant" : "user" },
            parts: [],
          },
        };
      },
    },
    permission: {
      list: async () => {
        const requests = await client.permission.request.list(location);
        for (const request of requests.data) {
          state.permissionSessions.set(request.id, request.sessionID);
        }
        return { data: requests.data.map(toLegacyPermission) };
      },
      reply: async (input: { requestID: string; reply: "once" | "always" | "reject" }) => {
        const sessionID = state.permissionSessions.get(input.requestID);
        if (sessionID === undefined) {
          throw new Error(`Unknown OpenCode permission request ${input.requestID}`);
        }
        await client.permission.reply({
          sessionID,
          requestID: input.requestID,
          decision: input.reply,
        });
        return { data: {} };
      },
    },
    question: {
      list: async () => {
        const forms = await client.form.list(location);
        for (const form of forms.data) state.formSessions.set(form.id, form);
        return { data: forms.data.map(toLegacyQuestion) };
      },
      reply: async (input: { requestID: string; answers: ReadonlyArray<string> }) => {
        const form = state.formSessions.get(input.requestID);
        if (form === undefined) {
          throw new Error(`Unknown OpenCode form ${input.requestID}`);
        }
        const fields = (form.fields ?? []) as ReadonlyArray<{ readonly key: string }>;
        await client.session.form.reply({
          sessionID: form.sessionID,
          formID: form.id,
          answer: toNextFormAnswer(fields, input.answers),
        });
        return { data: {} };
      },
    },
    event: {
      subscribe: async (
        _input: unknown,
        options?: { signal?: AbortSignal; onSseError?: (error: unknown) => void },
      ) => {
        const abort = new AbortController();
        const signal = options?.signal;
        if (signal !== undefined) {
          if (signal.aborted) abort.abort();
          else signal.addEventListener("abort", () => abort.abort(), { once: true });
        }
        void (async () => {
          try {
            for await (const event of client.event.subscribe({ signal: abort.signal })) {
              for (const translated of translate(event)) push(translated);
            }
          } catch (error) {
            if (!abort.signal.aborted) options?.onSseError?.(error);
          } finally {
            closeQueue();
          }
        })();
        return {
          stream: {
            [Symbol.asyncIterator]() {
              return {
                next: async () => {
                  const event = await nextQueued();
                  return event === undefined
                    ? { done: true as const, value: undefined }
                    : { done: false as const, value: event };
                },
              };
            },
          },
        };
      },
    },
  };

  return compat as unknown as OpencodeClient;
}

function toLegacySession(session: {
  id: string;
  parentID?: string;
  location: { directory: string };
  revert?: { messageID: string };
}): unknown {
  return {
    id: session.id,
    ...(session.parentID !== undefined ? { parentID: session.parentID } : {}),
    directory: session.location.directory,
    ...(session.revert !== undefined ? { revert: session.revert } : {}),
  };
}
