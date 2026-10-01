import {
  ChatGPTWebSettings,
  OpenCodeSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { ProviderAdapterRequestError, ProviderDriverError } from "../Errors.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { OpenCodeDriver, type OpenCodeDriverEnv } from "./OpenCodeDriver.ts";
import { SharedBrowserChatGPT } from "../chatgpt/SharedBrowserChatGPT.ts";
import { ChatGPTRateLimit } from "../chatgpt/ChatGPTRateLimit.ts";
import { startChatGPTBridge } from "../chatgpt/ChatGPTBridge.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";

const DRIVER = ProviderDriverKind.make("chatgptWeb");
const MODEL = "t3-chatgpt-web/auto";
const decodeSettings = Schema.decodeUnknownSync(ChatGPTWebSettings);
const decodeOpenCodeSettings = Schema.decodeUnknownEffect(OpenCodeSettings);
const encodeConfiguration = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const ChatGPTWebDriver: ProviderDriver<ChatGPTWebSettings, OpenCodeDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "ChatGPT Web", supportsMultipleInstances: false },
  configSchema: ChatGPTWebSettings,
  defaultConfig: () => decodeSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const settings = input.config;
      const paths = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.join(paths.stateDir, "chatgpt-web");
      const fail = (cause: unknown) =>
        new ProviderDriverError({
          driver: DRIVER,
          instanceId: input.instanceId,
          detail: cause instanceof Error ? cause.message : "Could not initialize ChatGPT Web.",
        });
      yield* fileSystem
        .makeDirectory(root, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(fail));
      const browser = new SharedBrowserChatGPT();
      const bridge = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const limiter = new ChatGPTRateLimit(path.join(root, "rate.sqlite"), {
              minimumIntervalSeconds: Number(settings.minimumIntervalSeconds),
              requestsPerHour: Number(settings.requestsPerHour),
              requestsPerDay: Number(settings.requestsPerDay),
              cooldownMinutes: Number(settings.cooldownMinutes),
            });
            try {
              return await startChatGPTBridge({ browser, limiter });
            } catch (error) {
              limiter.close();
              await browser.close();
              throw error;
            }
          },
          catch: fail,
        }),
        (resource) => Effect.promise(() => resource.close()),
      );
      const configuration = {
        enabled_providers: ["t3-chatgpt-web"],
        model: MODEL,
        small_model: MODEL,
        share: "disabled",
        autoupdate: false,
        // Website prompts have a byte budget, not a reported model context window.
        // Automatic compaction can loop on the fixed tool catalogue and spend requests.
        compaction: { auto: false },
        agent: { title: { disable: true } },
        provider: {
          "t3-chatgpt-web": {
            npm: "@ai-sdk/openai-compatible",
            name: "ChatGPT Web",
            options: { baseURL: bridge.url, apiKey: bridge.key },
            models: {
              auto: {
                name: "ChatGPT · current web model",
                tool_call: true,
                attachment: false,
                // Local runtime metadata; the website does not report its model context limit.
                limit: { context: 32000, output: 4000 },
              },
            },
          },
        },
      };
      const environment = (input.environment ?? []).filter(
        (entry) =>
          ![
            "OPENCODE_CONFIG",
            "OPENCODE_CONFIG_CONTENT",
            "OPENCODE_CONFIG_DIR",
            "OPENCODE_DISABLE_PROJECT_CONFIG",
            "XDG_CONFIG_HOME",
          ].includes(entry.name),
      );
      const configurationJson = yield* encodeConfiguration(configuration).pipe(
        Effect.mapError(fail),
      );
      const openCodeSettings = yield* decodeOpenCodeSettings({
        binaryPath: settings.binaryPath,
        enabled: input.enabled,
      }).pipe(Effect.mapError(fail));
      const base = yield* OpenCodeDriver.create({
        ...input,
        environment: [
          ...environment,
          { name: "OPENCODE_CONFIG_CONTENT", value: configurationJson, sensitive: true },
          { name: "OPENCODE_CONFIG_DIR", value: path.join(root, "opencode"), sensitive: false },
          // Keep unrelated OpenCode providers, plugins, and MCP catalogues out of web prompts.
          { name: "XDG_CONFIG_HOME", value: path.join(root, "config"), sensitive: false },
          { name: "OPENCODE_CONFIG", value: "", sensitive: false },
          { name: "OPENCODE_DISABLE_PROJECT_CONFIG", value: "true", sensitive: false },
        ],
        config: openCodeSettings,
      });
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId: input.instanceId,
      });
      const snapshot = (value: ServerProvider): ServerProvider => ({
        ...value,
        driver: DRIVER,
        displayName: input.displayName ?? "ChatGPT Web",
        badgeLabel: "Experimental",
        continuation: { groupKey: continuationIdentity.continuationKey },
        reportsContextWindow: false,
        setup: { canAuthenticate: false, canInstall: false },
        auth: { status: "unknown", type: "preview", label: "T3 shared browser" },
        message:
          value.status === "ready"
            ? "Uses ChatGPT in T3’s visible shared browser. Token counts are estimates; reasoning and cache counts are unavailable. Rate limits are editable below."
            : value.message,
        models: [
          {
            slug: MODEL,
            name: "ChatGPT · current web model",
            isDefault: true,
            isCustom: false,
            capabilities: { optionDescriptors: [] },
          },
        ],
        slashCommands: [],
      });
      let activeThread: string | undefined;
      const session = (value: ProviderSession): ProviderSession => ({ ...value, provider: DRIVER });
      const event = (value: ProviderRuntimeEvent): ProviderRuntimeEvent => {
        if (value.type === "turn.completed" && value.payload.tokenUsage) {
          return {
            ...value,
            provider: DRIVER,
            payload: {
              ...value.payload,
              tokenUsage: { ...value.payload.tokenUsage, usageStatus: "partial" },
            },
          };
        }
        return { ...value, provider: DRIVER };
      };
      return {
        ...base,
        driverKind: DRIVER,
        continuationIdentity,
        snapshot: {
          ...base.snapshot,
          resolveMaintenance: () =>
            Effect.succeed({ provider: DRIVER, packageName: null, update: null }),
          getSnapshot: base.snapshot.getSnapshot.pipe(Effect.map(snapshot)),
          refresh: base.snapshot.refresh.pipe(Effect.map(snapshot)),
          streamChanges: base.snapshot.streamChanges.pipe(Stream.map(snapshot)),
        },
        ...(base.snapshotForCwd
          ? {
              snapshotForCwd: (cwd: string) => base.snapshotForCwd!(cwd).pipe(Effect.map(snapshot)),
            }
          : {}),
        adapter: {
          ...base.adapter,
          provider: DRIVER,
          startSession: (value) => base.adapter.startSession(value).pipe(Effect.map(session)),
          sendTurn: (value) =>
            Effect.gen(function* () {
              if (activeThread)
                return yield* new ProviderAdapterRequestError({
                  provider: DRIVER,
                  method: "sendTurn",
                  detail:
                    "ChatGPT Web handles one turn at a time. Wait for the active turn to finish.",
                });
              const mcpSession = McpProviderSession.readMcpProviderSession(value.threadId);
              if (!mcpSession?.capabilities.has("preview"))
                return yield* new ProviderAdapterRequestError({
                  provider: DRIVER,
                  method: "sendTurn",
                  detail:
                    "Enable Agent browser access for this project, then start a new ChatGPT Web thread.",
                });
              activeThread = value.threadId;
              const scope: McpInvocationContext.McpInvocationScope | undefined = mcpSession
                ? {
                    environmentId: mcpSession.environmentId,
                    threadId: mcpSession.threadId,
                    providerSessionId: mcpSession.providerSessionId,
                    providerInstanceId: mcpSession.providerInstanceId,
                    capabilities: mcpSession.capabilities,
                    issuedAt: mcpSession.issuedAt,
                  }
                : undefined;
              browser.setScope(scope);
              return yield* base.adapter.sendTurn(value).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    browser.clearScope(value.threadId);
                    if (activeThread === value.threadId) activeThread = undefined;
                  }),
                ),
              );
            }),
          interruptTurn: (threadId, turnId) =>
            base.adapter.interruptTurn(threadId, turnId).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  browser.clearScope(threadId);
                  if (activeThread === threadId) activeThread = undefined;
                }),
              ),
            ),
          stopSession: (threadId) =>
            base.adapter.stopSession(threadId).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  browser.clearScope(threadId);
                  if (activeThread === threadId) activeThread = undefined;
                }),
              ),
            ),
          stopAll: () =>
            base.adapter.stopAll().pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  browser.close();
                  activeThread = undefined;
                }),
              ),
            ),
          listSessions: () =>
            base.adapter.listSessions().pipe(Effect.map((sessions) => sessions.map(session))),
          streamEvents: base.adapter.streamEvents.pipe(
            Stream.tap((value) =>
              Effect.sync(() => {
                if (value.type === "turn.completed" || value.type === "turn.aborted") {
                  browser.clearScope(value.threadId);
                  if (activeThread === value.threadId) activeThread = undefined;
                }
              }),
            ),
            Stream.map(event),
          ),
        },
        textGeneration: {
          ...base.textGeneration,
          // Titles should not silently spend another ChatGPT request before the user's turn.
          generateThreadTitle: ({ message }) =>
            Effect.succeed({
              title: message.trim().split("\n")[0]?.slice(0, 70) || "ChatGPT thread",
            }),
        },
      };
    }),
};
