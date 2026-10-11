import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  ProviderDriverKind,
  selectedCloudEnvironment,
  type ProviderCloudConfiguration,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";

import type { CodexAppServerClientFactoryShape } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type { makeCodexCloud } from "./CodexCloud.ts";

const record = Schema.Record(Schema.String, Schema.Unknown);
const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(record));
const decodeParams = Schema.decodeUnknownSync(record);

/** Translate local app-server envelopes into the cloud's saved-environment protocol. */
export function codexCloudMessage(message: string, config: ProviderCloudConfiguration): string {
  const wire = decodeMessage(message);
  const params = wire.params == null ? {} : decodeParams(wire.params);
  if (wire.method === "thread/start") {
    if (!config.published && config.threadId)
      return JSON.stringify({
        ...wire,
        method: "thread/resume",
        params: { threadId: config.threadId, excludeTurns: false },
      });
    return JSON.stringify({
      ...wire,
      params: {
        model: params.model,
        serviceName: "codex_cloud",
        deferredEnvironment: true,
        pluginsMcp: { productSku: "codex" },
        environments: [
          config.published ? { environmentConfigId: config.id } : { onboardingConfigId: config.id },
        ],
      },
    });
  }
  if (wire.method === "thread/resume")
    return JSON.stringify({
      ...wire,
      params: { threadId: params.threadId, excludeTurns: params.excludeTurns },
    });
  if (wire.method === "turn/start") {
    const {
      cwd: _cwd,
      config: _config,
      sandboxPolicy: _sandboxPolicy,
      permissionProfile: _permissionProfile,
      approvalPolicy: _approvalPolicy,
      approvalsReviewer: _approvalsReviewer,
      additionalContext: _additionalContext,
      collaborationMode,
      ...cloudParams
    } = params;
    return JSON.stringify({
      ...wire,
      params: {
        ...cloudParams,
        ...(collaborationMode && typeof collaborationMode === "object"
          ? {
              collaborationMode: {
                ...decodeParams(collaborationMode),
                settings: {
                  ...decodeParams(decodeParams(collaborationMode).settings),
                  developer_instructions: null,
                },
              },
            }
          : {}),
        ...(!config.published ? { turnTrigger: "environment_onboarding" } : {}),
      },
    });
  }
  return message;
}

/** Uses the normal Codex conversation adapter, replacing only its process I/O with cloud frames. */
export const makeCodexCloudClientFactory = (
  cloud: Effect.Success<ReturnType<typeof makeCodexCloud>>,
): CodexAppServerClientFactoryShape => ({
  open: (input) =>
    Effect.gen(function* () {
      const id = selectedCloudEnvironment(input.modelSelection.options);
      if (!id)
        return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
          driver: ProviderDriverKind.make("codex"),
          providerSessionId: input.providerSessionId,
          cause: new Error("Choose a cloud environment before starting a thread."),
        });
      const auth = yield* cloud.readAuth();
      const config = yield* cloud.read(id);
      const socket = yield* Socket.makeWebSocket("wss://codex-cloud-backend.chatgpt.com/", {
        openTimeout: "15 seconds",
      }).pipe(
        Effect.provideService(
          Socket.WebSocketConstructor,
          (url) =>
            new NodeSocket.NodeWS.WebSocket(
              url,
              ["codex-app-server", "codex-client.desktop", `openai-bearer.${auth.access_token}`],
              {
                headers: {
                  "X-OpenAI-Product-Sku": "codex",
                  "X-OpenAI-Allow-Environmentless-Fallback": "true",
                  ...(auth.account_id ? { "ChatGPT-Account-Id": auth.account_id } : {}),
                },
              },
            ),
        ),
      );
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const ioError = () =>
        new PlatformError.PlatformError(
          new PlatformError.SystemError({
            _tag: "Unknown",
            module: "Socket",
            method: "cloud-conversation",
          }),
        );
      let pending = "";
      const stdio = Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.fromPull(Effect.succeed(reader.pull)).pipe(
          Stream.map((frame) =>
            encoder.encode(`${typeof frame === "string" ? frame : decoder.decode(frame)}\n`),
          ),
          Stream.mapError(ioError),
        ),
        stdout: () =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.gen(function* () {
              pending +=
                typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
              let newline: number;
              while ((newline = pending.indexOf("\n")) >= 0) {
                const message = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                if (message.trim())
                  yield* writer
                    .write(codexCloudMessage(message, config))
                    .pipe(Effect.mapError(ioError));
              }
            }),
          ),
        stderr: () => Sink.drain,
      });
      return yield* CodexClient.make(stdio);
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapter.ProviderAdapterOpenSessionError({
            driver: ProviderDriverKind.make("codex"),
            providerSessionId: input.providerSessionId,
            cause,
          }),
      ),
    ),
});
