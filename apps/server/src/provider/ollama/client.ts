import type {
  ChatAttachment,
  OllamaConnectionSettings,
  OllamaModelOptions,
  ServerProviderAuth,
  ServerProviderConnection,
  ServerProviderModel,
  ServerProviderState,
  ServerSettings,
} from "@t3tools/contracts";
import { Effect, FileSystem } from "effect";
import { resolveAttachmentPath } from "../../attachmentStore.ts";

export const OLLAMA_DEFAULT_TIMEOUT_MS = 120_000;
type RequestHeaders = Readonly<Record<string, string>>;

export interface OllamaResolvedConnection {
  readonly connection: OllamaConnectionSettings;
  readonly auth: ServerProviderAuth;
}

export interface OllamaConnectionProbeResult {
  readonly connection: ServerProviderConnection;
}

interface OllamaTagResponse {
  readonly models?: ReadonlyArray<{
    readonly name?: string;
  }>;
}

interface OllamaVersionResponse {
  readonly version?: string;
}

function trimOrUndefined(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function authForConnection(connection: OllamaConnectionSettings): ServerProviderAuth {
  if (connection.authMode === "none") {
    return {
      status: "authenticated",
      type: "none",
      label: "No auth",
    };
  }

  if (trimOrUndefined(connection.apiKey)) {
    return {
      status: "authenticated",
      type: "bearer",
      label: "Bearer token",
    };
  }

  return {
    status: "unauthenticated",
    type: "bearer",
    label: "Missing bearer token",
  };
}

export function resolveOllamaConnections(
  settings: Pick<ServerSettings, "providers">,
): ReadonlyArray<OllamaResolvedConnection> {
  return settings.providers.ollama.connections.map((connection) => ({
    connection: {
      ...connection,
      baseUrl: normalizeBaseUrl(connection.baseUrl || "http://127.0.0.1:11434"),
    },
    auth: authForConnection(connection),
  }));
}

export function resolveDefaultOllamaConnection(
  settings: Pick<ServerSettings, "providers">,
): OllamaResolvedConnection | undefined {
  const resolved = resolveOllamaConnections(settings);
  return resolved.find((entry) => entry.connection.isDefault) ?? resolved[0];
}

export function resolveOllamaConnectionForSelection(input: {
  readonly settings: ServerSettings;
  readonly modelOptions?: OllamaModelOptions | null;
  readonly resumeConnectionId?: string | null;
}): OllamaResolvedConnection | undefined {
  const resolvedConnections = resolveOllamaConnections(input.settings);
  const requestedId =
    trimOrUndefined(input.modelOptions?.connectionId) ?? trimOrUndefined(input.resumeConnectionId);
  if (requestedId) {
    const exact = resolvedConnections.find((entry) => entry.connection.id === requestedId);
    if (exact) {
      return exact;
    }
  }
  return resolveDefaultOllamaConnection(input.settings);
}

function dedupeModels(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const next: ServerProviderModel[] = [];
  for (const model of models) {
    if (seen.has(model.slug)) continue;
    seen.add(model.slug);
    next.push(model);
  }
  return next;
}

function decodeJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function fetchJson<T>(input: {
  readonly url: string;
  readonly headers: RequestHeaders;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  try {
    const response = await fetch(input.url, {
      method: "GET",
      headers: input.headers,
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        body.trim() || `HTTP ${response.status} while fetching ${new URL(input.url).pathname}`,
      );
    }
    return await decodeJson<T>(response);
  } finally {
    clearTimeout(timeout);
  }
}

function headersForConnection(connection: OllamaConnectionSettings): RequestHeaders {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (connection.authMode === "bearer" && trimOrUndefined(connection.apiKey)) {
    headers.Authorization = `Bearer ${connection.apiKey.trim()}`;
  }
  return headers;
}

export const probeOllamaConnection = (input: { readonly connection: OllamaResolvedConnection }) =>
  Effect.tryPromise(async () => {
    const checkedAt = new Date().toISOString();
    const timeoutMs = input.connection.connection.requestTimeoutMs ?? OLLAMA_DEFAULT_TIMEOUT_MS;
    const headers = headersForConnection(input.connection.connection);
    const baseUrl = input.connection.connection.baseUrl;
    const [versionResponse, tagResponse] = await Promise.all([
      fetchJson<OllamaVersionResponse>({
        url: `${baseUrl}/api/version`,
        headers,
        timeoutMs,
      }),
      fetchJson<OllamaTagResponse>({
        url: `${baseUrl}/api/tags`,
        headers,
        timeoutMs,
      }),
    ]);

    const discoveredModels = (tagResponse.models ?? [])
      .map((model) => trimOrUndefined(model.name))
      .filter((model): model is string => model !== undefined)
      .map(
        (model) =>
          ({
            slug: model,
            name: model,
            isCustom: false,
            capabilities: null,
          }) satisfies ServerProviderModel,
      );

    const customModels = input.connection.connection.customModels
      .map((model) => trimOrUndefined(model))
      .filter((model): model is string => model !== undefined)
      .map(
        (model) =>
          ({
            slug: model,
            name: model,
            isCustom: true,
            capabilities: null,
          }) satisfies ServerProviderModel,
      );

    const status: ServerProviderState =
      input.connection.auth.status === "unauthenticated" ? "warning" : "ready";

    return {
      connection: {
        id: input.connection.connection.id,
        name: input.connection.connection.name,
        baseUrl,
        isDefault: input.connection.connection.isDefault,
        enabled: true,
        version: trimOrUndefined(versionResponse.version) ?? null,
        status,
        auth: input.connection.auth,
        checkedAt,
        models: [...dedupeModels([...discoveredModels, ...customModels])],
      } satisfies ServerProviderConnection,
    } satisfies OllamaConnectionProbeResult;
  });

export function combineOllamaProviderState(connections: ReadonlyArray<ServerProviderConnection>): {
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
} {
  if (connections.length === 0) {
    return {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "No Ollama connections configured.",
      models: [],
    };
  }

  const defaultConnection = connections.find((entry) => entry.isDefault) ?? connections[0]!;
  const readyConnections = connections.filter((entry) => entry.status === "ready");
  const warningConnections = connections.filter((entry) => entry.status === "warning");
  const version = defaultConnection.version;
  const models = dedupeModels(connections.flatMap((connection) => connection.models));

  if (readyConnections.length > 0) {
    return {
      installed: true,
      version,
      status: warningConnections.length > 0 ? "warning" : "ready",
      auth: defaultConnection.auth,
      ...(warningConnections.length > 0
        ? { message: `${warningConnections.length} Ollama connection requires attention.` }
        : {}),
      models,
    };
  }

  return {
    installed: true,
    version,
    status: "error",
    auth: defaultConnection.auth,
    message:
      defaultConnection.message ??
      "Ollama is configured, but none of the configured connections are reachable.",
    models,
  };
}

export interface OllamaChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly images?: ReadonlyArray<string>;
}

export interface OllamaChatResponseChunk {
  readonly model?: string;
  readonly message?: {
    readonly content?: string;
  };
  readonly done?: boolean;
  readonly done_reason?: string;
  readonly eval_count?: number;
  readonly prompt_eval_count?: number;
}

export async function postOllamaChat(input: {
  readonly connection: OllamaConnectionSettings;
  readonly model: string;
  readonly messages: ReadonlyArray<OllamaChatMessage>;
  readonly signal?: AbortSignal;
  readonly format?: unknown;
}): Promise<Response> {
  const requestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headersForConnection(input.connection),
    },
    body: JSON.stringify({
      model: input.model,
      stream: true,
      messages: input.messages,
      ...(input.format !== undefined ? { format: input.format } : {}),
    }),
    ...(input.signal ? { signal: input.signal } : {}),
  } satisfies RequestInit;
  const response = await fetch(`${input.connection.baseUrl}/api/chat`, {
    ...requestInit,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body.trim() || `Ollama chat request failed with HTTP ${response.status}.`);
  }

  return response;
}

export const attachmentImagesForOllama = (input: {
  readonly attachmentsDir: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const encoded = yield* Effect.forEach(input.attachments, (attachment) =>
      Effect.gen(function* () {
        const path = resolveAttachmentPath({
          attachmentsDir: input.attachmentsDir,
          attachment,
        });
        if (!path) {
          return undefined;
        }
        const bytes = yield* fileSystem.readFile(path);
        return Buffer.from(bytes).toString("base64");
      }).pipe(Effect.orElseSucceed(() => undefined)),
    );

    return encoded.filter((value): value is string => typeof value === "string");
  });
