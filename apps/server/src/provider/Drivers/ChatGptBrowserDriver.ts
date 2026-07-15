/**
 * ChatGptBrowserDriver — direct browser automation bridge to chatgpt.com.
 *
 * This is intentionally a pragmatic fallback connector for users who already
 * have ChatGPT connected to a local DevSpace MCP server. It drives the ChatGPT
 * website in a real browser via Playwright/CDP and reflects the response back
 * through SergeCode's normal provider runtime stream.
 *
 * @module provider/Drivers/ChatGptBrowserDriver
 */
import {
  ChatGptBrowserSettings,
  ProviderDriverKind,
  type ServerProvider,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeChatGptBrowserAdapter } from "../Layers/ChatGptBrowserAdapter.ts";
import {
  checkChatGptBrowserProviderStatus,
  makePendingChatGptBrowserProvider,
} from "../Layers/ChatGptBrowserProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const DRIVER_KIND = ProviderDriverKind.make("chatgpt");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const decodeChatGptBrowserSettings = Schema.decodeSync(ChatGptBrowserSettings);

export type ChatGptBrowserDriverEnv = HttpClient.HttpClient | ServerSettingsService;

const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "playwright-core",
});

const unsupportedTextGeneration = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        "ChatGPT browser connector does not support background text generation. Select Codex, Claude, Grok, or OpenCode for commit messages, PR text, branch names, and titles.",
    }),
  );

const textGeneration: TextGeneration["Service"] = {
  generateCommitMessage: () => unsupportedTextGeneration("generateCommitMessage"),
  generatePrContent: () => unsupportedTextGeneration("generatePrContent"),
  generateBranchName: () => unsupportedTextGeneration("generateBranchName"),
  generateThreadTitle: () => unsupportedTextGeneration("generateThreadTitle"),
  generateScenerySet: () => unsupportedTextGeneration("generateScenerySet"),
};

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const ChatGptBrowserDriver: ProviderDriver<ChatGptBrowserSettings, ChatGptBrowserDriverEnv> =
  {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: "ChatGPT",
      supportsMultipleInstances: true,
    },
    configSchema: ChatGptBrowserSettings,
    defaultConfig: (): ChatGptBrowserSettings => decodeChatGptBrowserSettings({}),
    create: ({ instanceId, displayName, accentColor, enabled, config }) =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsService;
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind: DRIVER_KIND,
          instanceId,
        });
        const stampIdentity = withInstanceIdentity({
          instanceId,
          displayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });
        const effectiveConfig = { ...config, enabled } satisfies ChatGptBrowserSettings;

        const httpClient = yield* HttpClient.HttpClient;
        const adapter = yield* makeChatGptBrowserAdapter(effectiveConfig, { instanceId });
        const snapshotSettings = makeProviderSnapshotSettingsSource(
          effectiveConfig,
          serverSettings,
        );
        const snapshot = yield* makeManagedServerProvider<
          ProviderSnapshotSettings<ChatGptBrowserSettings>
        >({
          maintenanceCapabilities,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            makePendingChatGptBrowserProvider(settings.provider).pipe(Effect.map(stampIdentity)),
          checkProvider: checkChatGptBrowserProviderStatus(effectiveConfig).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.map(stampIdentity),
          ),
          refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Failed to build ChatGPT browser snapshot: ${cause.message ?? String(cause)}`,
                cause,
              }),
          ),
        );

        return {
          instanceId,
          driverKind: DRIVER_KIND,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          snapshot,
          adapter,
          textGeneration,
        } satisfies ProviderInstance;
      }),
  };
