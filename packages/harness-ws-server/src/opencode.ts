import type {
  EventId,
  HarnessCapabilitySet,
  HarnessEvent,
  HarnessNativeFrame,
  HarnessProfile,
  HarnessSession,
} from "@t3tools/contracts";
import {
  EventId as EventIdSchema,
  HarnessSessionId,
  RuntimeRequestId,
} from "@t3tools/contracts";
import {
  type HarnessAdapter,
  HarnessAdapterError,
  assertHarness,
  assertSessionHarness,
} from "./adapters";

export const OPENCODE_HARNESS_CAPABILITIES: HarnessCapabilitySet = {
  resume: true,
  cancel: true,
  modelSwitch: "restart-required",
  permissions: true,
  elicitation: true,
  toolLifecycle: true,
  reasoningStream: false,
  planStream: true,
  fileArtifacts: true,
  checkpoints: false,
  subagents: true,
};

type FetchLike = typeof fetch;

interface OpenCodeSessionInfo {
  readonly id: string;
  readonly title?: string;
}

interface OpenCodeSseEvent {
  readonly type: string;
  readonly properties: Record<string, unknown>;
}

interface OpenCodeQuestionEvent {
  readonly id?: string;
  readonly header?: string;
  readonly question?: string;
  readonly options?: ReadonlyArray<{
    readonly label?: string;
    readonly description?: string;
  }>;
  readonly multiple?: boolean;
  readonly custom?: boolean;
}

export interface OpenCodeHarnessAdapterOptions {
  readonly fetch?: FetchLike;
  readonly adapterKey?: string;
}

function trim(value: string | undefined | null): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

function makeBasicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function requireBaseUrl(profile: HarnessProfile): string {
  const baseUrl = trim(profile.config.opencode?.baseUrl);
  if (!baseUrl) {
    throw new HarnessAdapterError(
      `OpenCode profile '${profile.id}' requires 'config.opencode.baseUrl'.`,
    );
  }
  return baseUrl.replace(/\/+$/, "");
}

function buildHeaders(profile: HarnessProfile): HeadersInit {
  const username = trim(profile.config.opencode?.username);
  const password = trim(profile.config.opencode?.password);
  if (username && password) {
    return {
      Authorization: makeBasicAuthHeader(username, password),
    };
  }
  return {};
}

function makeEventId(session: HarnessSession, sequence: number): EventId {
  return EventIdSchema.makeUnsafe(`opencode:${session.id}:${sequence}`);
}

function getSessionBaseUrl(session: HarnessSession): string {
  const baseUrl = trim(session.metadata?.baseUrl as string | undefined);
  if (!baseUrl) {
    throw new HarnessAdapterError("OpenCode session metadata is missing baseUrl.");
  }
  return baseUrl.replace(/\/+$/, "");
}

async function decodeJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new HarnessAdapterError(`OpenCode request failed with status ${response.status}.`, {
      status: response.status,
      text: await response.text(),
    });
  }
  return (await response.json()) as T;
}

async function* parseSseEvents(
  response: Response,
  session: HarnessSession,
  adapterKey: string,
): AsyncIterable<HarnessEvent> {
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sequence = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const dataLine = frame
        .split("\n")
        .find((line) => line.startsWith("data:"));
      if (!dataLine) {
        continue;
      }
      const json = dataLine.slice("data:".length).trim();
      if (!json) {
        continue;
      }
      const event = JSON.parse(json) as OpenCodeSseEvent;
      sequence += 1;
      const base: Omit<HarnessEvent, "payload"> = {
        eventId: makeEventId(session, sequence),
        sessionId: session.id,
        createdAt: new Date().toISOString(),
        sequence,
        harness: "opencode",
        adapterKey,
        connectionMode: session.connectionMode,
        type: "native.frame",
      } as Omit<HarnessEvent, "payload">;

      if (event.type === "permission.asked") {
        yield {
          ...base,
          type: "permission.requested",
          payload: {
            requestId: RuntimeRequestId.makeUnsafe(String(event.properties.id)),
            kind: "other",
            title: String(
              event.properties.message ?? event.properties.permission ?? "Permission requested",
            ),
            ...(event.properties.message ? { detail: String(event.properties.message) } : {}),
            args: event.properties.metadata,
          },
        };
        continue;
      }

      if (event.type === "permission.replied") {
        yield {
          ...base,
          type: "permission.resolved",
          payload: {
            requestId: RuntimeRequestId.makeUnsafe(String(event.properties.requestID)),
            decision:
              event.properties.reply === "always"
                ? "accept-for-session"
                : event.properties.reply === "once"
                  ? "accept"
                  : "decline",
          },
        };
        continue;
      }

      if (event.type === "question.asked") {
        yield {
          ...base,
          type: "elicitation.requested",
          payload: {
            requestId: RuntimeRequestId.makeUnsafe(String(event.properties.id)),
            questions: Array.isArray(event.properties.questions)
              ? event.properties.questions.map((question) => {
                  const typedQuestion = question as OpenCodeQuestionEvent;
                  return {
                    id: String(typedQuestion.id ?? typedQuestion.header ?? "question"),
                    header: String(typedQuestion.header ?? "Question"),
                    question: String(typedQuestion.question ?? ""),
                    options: Array.isArray(typedQuestion.options)
                      ? typedQuestion.options.map((option) => ({
                          label: String(option.label ?? ""),
                          description: String(option.description ?? ""),
                        }))
                      : [],
                    ...(typedQuestion.multiple !== undefined
                      ? { multiple: Boolean(typedQuestion.multiple) }
                      : {}),
                    ...(typedQuestion.custom !== undefined
                      ? { custom: Boolean(typedQuestion.custom) }
                      : {}),
                  };
                })
              : [],
          },
        };
        continue;
      }

      if (event.type === "question.replied" || event.type === "question.rejected") {
        yield {
          ...base,
          type: "elicitation.resolved",
          payload: {
            requestId: RuntimeRequestId.makeUnsafe(String(event.properties.requestID)),
            answers: Array.isArray(event.properties.answers)
              ? event.properties.answers.map((answer) =>
                  Array.isArray(answer) ? answer.map(String) : [String(answer)],
                )
              : [],
          },
        };
        continue;
      }

      if (event.type === "session.status") {
        const statusType = String((event.properties.status as { type?: string } | undefined)?.type ?? "idle");
        yield {
          ...base,
          type: "session.state.changed",
          payload: {
            state: statusType === "busy" ? "running" : statusType === "retry" ? "waiting" : "ready",
          },
        };
        continue;
      }

      yield {
        ...base,
        type: "native.frame",
        payload: {
          source: event.type,
          payload: event.properties,
        },
      };
    }
  }
}

function toHarnessSession(profile: HarnessProfile, session: OpenCodeSessionInfo): HarnessSession {
  const now = new Date().toISOString();
  return {
    id: HarnessSessionId.makeUnsafe(session.id),
    profileId: profile.id,
    harness: "opencode",
    adapterKey: "opencode-direct",
    connectionMode: profile.connectionMode,
    title: session.title ?? null,
    cwd: profile.config.opencode?.directory ?? null,
    model: null,
    mode: null,
    state: "ready",
    activeTurnId: null,
    nativeSessionId: session.id,
    lastError: null,
    capabilities: OPENCODE_HARNESS_CAPABILITIES,
    metadata: {
      baseUrl: requireBaseUrl(profile),
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function createOpenCodeHarnessAdapter(
  options?: OpenCodeHarnessAdapterOptions,
): HarnessAdapter {
  const request = options?.fetch ?? fetch;
  const adapterKey = options?.adapterKey ?? "opencode-direct";

  return {
    key: adapterKey,
    harness: "opencode",
    family: "process",
    defaultConnectionMode: "spawned",
    capabilities: OPENCODE_HARNESS_CAPABILITIES,
    validateProfile(profile) {
      assertHarness(profile, "opencode");
      requireBaseUrl(profile);
    },
    async createSession(input) {
      this.validateProfile(input.profile);
      const baseUrl = requireBaseUrl(input.profile);
      const response = await request(`${baseUrl}/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...buildHeaders(input.profile),
        },
        body: JSON.stringify(
          input.title ? { title: input.title } : {},
        ),
      });
      const created = await decodeJson<OpenCodeSessionInfo>(response);
      return toHarnessSession(input.profile, created);
    },
    async resumeSession(input) {
      assertSessionHarness(input.session, "opencode");
      return input.session;
    },
    async sendTurn(input) {
      assertSessionHarness(input.session, "opencode");
      const baseUrl = getSessionBaseUrl(input.session);
      const response = await request(`${baseUrl}/session/${input.session.id}/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: input.input ?? "",
        }),
      });
      if (!response.ok) {
        throw new HarnessAdapterError(`OpenCode prompt failed with status ${response.status}.`);
      }
    },
    async cancelTurn(input) {
      assertSessionHarness(input.session, "opencode");
      const baseUrl = getSessionBaseUrl(input.session);
      const response = await request(`${baseUrl}/session/${input.session.id}/abort`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new HarnessAdapterError(`OpenCode abort failed with status ${response.status}.`);
      }
    },
    async resolvePermission(input) {
      assertSessionHarness(input.session, "opencode");
      const baseUrl = getSessionBaseUrl(input.session);
      const reply =
        input.decision === "accept-for-session"
          ? "always"
          : input.decision === "accept"
            ? "once"
            : "reject";
      const response = await request(`${baseUrl}/permission/${input.requestId}/reply`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ reply }),
      });
      if (!response.ok) {
        throw new HarnessAdapterError(
          `OpenCode permission reply failed with status ${response.status}.`,
        );
      }
    },
    async resolveElicitation(input) {
      assertSessionHarness(input.session, "opencode");
      const baseUrl = getSessionBaseUrl(input.session);
      const response = await request(`${baseUrl}/question/${input.requestId}/reply`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ answers: input.answers }),
      });
      if (!response.ok) {
        throw new HarnessAdapterError(`OpenCode question reply failed with status ${response.status}.`);
      }
    },
    async updateSessionConfig(input) {
      assertSessionHarness(input.session, "opencode");
      const baseUrl = getSessionBaseUrl(input.session);
      const response = await request(`${baseUrl}/session/${input.session.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(input.title !== undefined ? { title: input.title } : {}),
      });
      if (!response.ok) {
        throw new HarnessAdapterError(`OpenCode session update failed with status ${response.status}.`);
      }
    },
    async shutdownSession(input) {
      assertSessionHarness(input.session, "opencode");
      return this.cancelTurn({ session: input.session });
    },
    async *streamEvents(input) {
      assertSessionHarness(input.session, "opencode");
      const baseUrl = getSessionBaseUrl(input.session);
      const response = await request(`${baseUrl}/event`, input.signal
        ? {
            method: "GET",
            signal: input.signal,
          }
        : {
            method: "GET",
          });
      yield* parseSseEvents(response, input.session, adapterKey);
    },
  };
}

export function createOpenCodeNativeFrame(
  session: HarnessSession,
  source: string,
  payload: unknown,
  sequence: number,
): HarnessNativeFrame {
  return {
    id: EventIdSchema.makeUnsafe(`opencode-frame:${session.id}:${sequence}`),
    sessionId: session.id,
    harness: "opencode",
    adapterKey: session.adapterKey,
    createdAt: new Date().toISOString(),
    source,
    payload,
  };
}
