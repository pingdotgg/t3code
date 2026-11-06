import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import {
  type ProviderInteractionMode,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { VibeSettings } from "../settings.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";

import * as VibeAppServer from "@t3tools/vibe-app-server/client";
import * as VibeError from "@t3tools/vibe-app-server/errors";

export const VIBE_PROVIDER = ProviderDriverKind.make("vibe");
export const VIBE_DEFAULT_BINARY = "vibe-app-server";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
/**
 * Applies a `history/entryUpdated` patch: RFC 6902 add/replace/remove plus Vibe's non-standard
 * `append`, which streams assistant text by concatenating onto an existing string.
 */
export function applyVibeHistoryPatch(
  target: Record<string, unknown>,
  patch: ReadonlyArray<unknown>,
): Record<string, unknown> {
  const result = structuredClone(target);
  for (const operation of patch) {
    const op = asRecord(operation);
    const segments = (str(op?.["path"]) ?? "")
      .split("/")
      .slice(1)
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (!op || segments.length === 0) continue;
    let cursor: unknown = result;
    for (const segment of segments.slice(0, -1)) {
      cursor =
        typeof cursor === "object" && cursor !== null
          ? (cursor as Record<string, unknown>)[segment]
          : undefined;
    }
    if (typeof cursor !== "object" || cursor === null) continue;
    const key = segments[segments.length - 1]!;
    const value = op["value"];
    if (Array.isArray(cursor)) {
      const index = key === "-" ? cursor.length : Number(key);
      if (!Number.isInteger(index) || index < 0 || index > cursor.length) continue;
      if (op["op"] === "remove") cursor.splice(index, 1);
      else if (op["op"] === "add") cursor.splice(index, 0, value);
      else if (op["op"] === "append" && typeof cursor[index] === "string")
        cursor[index] = `${cursor[index]}${typeof value === "string" ? value : ""}`;
      else cursor[index] = value;
      continue;
    }
    const record = cursor as Record<string, unknown>;
    if (op["op"] === "remove") delete record[key];
    else if (op["op"] === "append") {
      const current = record[key];
      record[key] =
        `${typeof current === "string" ? current : ""}${typeof value === "string" ? value : ""}`;
    } else record[key] = value;
  }
  return result;
}

/** T3's per-thread MCP endpoint as a Vibe session MCP server, so Vibe agents get T3's tools. */
export function vibeMcpServers(
  session: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader"> | undefined,
) {
  return session === undefined
    ? []
    : [
        {
          transport: "streamable-http" as const,
          name: "t3-code",
          url: session.endpoint,
          headers: { Authorization: session.authorizationHeader },
        },
      ];
}

const T3_PROMPT_ENVELOPE =
  /^<t3_code_orchestration_instructions>[\s\S]*?<\/t3_code_orchestration_instructions>\n\n<user_request>\n([\s\S]*)\n<\/user_request>$/;

/** Vibe stores the prompt as sent; replayed user messages drop T3's instruction envelope. */
export function stripT3PromptInstructions(text: string): string {
  return T3_PROMPT_ENVELOPE.exec(text)?.[1] ?? text;
}

export const DEFAULT_VIBE_MODEL = "mistral-medium-3.5";

/** Mistral Vibe's application rate-limit code, outside the JSON-RPC reserved range. */
export const MISTRAL_VIBE_RATE_LIMITED = -31001;

export class VibeModelUnavailableError extends Schema.TaggedError<VibeModelUnavailableError>()(
  "VibeModelUnavailableError",
  {
    model: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Vibe can't run the model "${this.model}" on your Mistral account right now. Choose another Vibe model, then retry.`;
  }
}

const isVibeRequestError = Schema.is(VibeError.VibeAppServerRequestError);

/** Vibe's `config/model/write` rejection of a model the account does not offer (`_config_write.py`). */
export const vibeModelWriteError = (model: string, cause: unknown): unknown =>
  isVibeRequestError(cause) &&
  cause.code === "invalid_params" &&
  cause.detail.startsWith("Unknown model:")
    ? new VibeModelUnavailableError({ model, cause })
    : cause;

type VibeAppServerSettings = Pick<
  VibeSettings,
  "binaryPath" | "localModelEnabled" | "localModelBaseUrl" | "localModelId"
>;

export interface VibeSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export function buildVibeEnvironment(
  settings: VibeAppServerSettings | null | undefined,
  environment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  if (!settings?.localModelEnabled) return environment;
  const apiBase = settings.localModelBaseUrl.trim() || "http://127.0.0.1:11434/v1";
  const model = settings.localModelId.trim() || "devstral-small-2";
  return {
    ...environment,
    VIBE_PROVIDERS: JSON.stringify([
      {
        name: "local",
        api_base: apiBase,
        api_style: "openai",
        backend: "generic",
        api_key_env_var: "",
      },
    ]),
    VIBE_MODELS: JSON.stringify([
      {
        name: model,
        provider: "local",
        alias: "local",
        input_price: 0,
        output_price: 0,
      },
    ]),
  };
}

/** The app server runs in the session's cwd — the thread's checkout when it owns a worktree. */
export function buildVibeSpawnInput(
  settings: VibeAppServerSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): VibeSpawnInput {
  const env = buildVibeEnvironment(settings, environment);
  return {
    command: settings?.binaryPath || VIBE_DEFAULT_BINARY,
    args: [],
    cwd,
    ...(env ? { env } : {}),
  };
}

export function resolveVibeModelId(model: string | null | undefined): string {
  return model?.trim() || DEFAULT_VIBE_MODEL;
}

/**
 * Maps T3's runtime policy to Vibe's agent (permission mode). `full-access`
 * additionally sets `autoApprove`, which bypasses tool permissions entirely.
 */
export function vibeAgentForRuntimeMode(
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode = "default",
): { readonly agent: string; readonly autoApprove: boolean } {
  if (interactionMode === "plan") return { agent: "plan", autoApprove: false };
  switch (runtimeMode) {
    case "approval-required":
      return { agent: "default", autoApprove: false };
    case "auto-accept-edits":
    case "auto":
      return { agent: "accept-edits", autoApprove: false };
    case "full-access":
      return { agent: "accept-edits", autoApprove: true };
  }
}

export interface VibeAppServerHandle {
  readonly client: VibeAppServer.VibeAppServerClient["Service"];
  readonly child: ChildProcessSpawner.ChildProcessHandle;
}

/**
 * Spawns `vibe-app-server` in `cwd` and returns a connected client.
 * Scoped: closing the scope kills the process.
 */
export const withVibeAppServerClient = Effect.fn("VibeAppServerSupport.withVibeAppServerClient")(
  function* <A, E, R>(
    input: {
      readonly settings?: VibeAppServerSettings | null | undefined;
      readonly cwd: string;
      readonly environment?: NodeJS.ProcessEnv | undefined;
      readonly clientInfo?: { readonly name: string; readonly version: string };
      readonly logProtocol?: boolean;
    },
    use: (
      client: VibeAppServer.VibeAppServerClient["Service"],
      serverInfo: VibeAppServer.InitializeResult["serverInfo"],
    ) => Effect.Effect<A, E, R>,
  ): Effect.fn.Return<
    A,
    E | VibeError.VibeAppServerError,
    R | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  > {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawn = buildVibeSpawnInput(input.settings, input.cwd, input.environment);
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawn.command, [...spawn.args], {
          // A server that ignores SIGTERM must not block scope close (and the request timeout).
          forceKillAfter: "1 second",
          ...(spawn.cwd !== undefined ? { cwd: spawn.cwd } : {}),
          ...(spawn.env !== undefined ? { env: spawn.env } : {}),
        }),
      )
      .pipe(
        Effect.mapError(
          (cause): VibeError.VibeAppServerError =>
            new VibeError.VibeAppServerProtocolError({
              detail: `Failed to spawn ${spawn.command}.`,
              cause,
            }),
        ),
      );
    const client = Context.get(
      yield* Layer.build(
        VibeAppServer.layerChildProcess(
          child,
          input.logProtocol === true ? { logIncoming: true, logOutgoing: true } : {},
        ),
      ),
      VibeAppServer.VibeAppServerClient,
    );
    const init = yield* client.initialize({
      clientName: input.clientInfo?.name ?? "t3-code",
      clientVersion: input.clientInfo?.version ?? "0.0.0",
      // Non-interactive contexts (probe, text generation) cannot answer prompts: advertise
      // callbacks so delivery is accepted, then resolve them immediately as declined.
      capabilities: {
        callbackKinds: ["approval", "user_input"],
      },
    });
    yield* client.initialized();
    yield* client.handleUnknownServerRequest((method, params) => {
      if (method !== "callback/call") {
        return Effect.fail(
          new VibeError.VibeAppServerRequestError({
            method,
            code: "method_not_found",
            detail: `Unsupported vibe-app-server request: ${method}`,
          }),
        );
      }
      const callback = asRecord(asRecord(params)?.["callback"]);
      const callbackId = str(callback?.["callbackId"]) ?? str(callback?.["callback_id"]);
      const sessionId = str(callback?.["sessionId"]);
      if (!callbackId || !sessionId) return Effect.succeed({ accepted: false });
      return Effect.as(
        client.callbackResult({
          sessionId,
          callbackId,
          result: { error: "not answerable in this context" },
        }),
        { callbackId, accepted: true },
      );
    });
    return yield* use(client, init.serverInfo).pipe(
      Effect.ensuring(child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore)),
    );
  },
);
