import { type ChatGptBrowserSettings, type ServerProviderModel } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { createModelCapabilities } from "@t3tools/shared/model";
import { ProviderValidationError } from "../Errors.ts";
import {
  buildServerProvider,
  nonEmptyTrimmed,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const CHATGPT_BROWSER_PRESENTATION = {
  displayName: "ChatGPT",
  badgeLabel: "Browser",
  showInteractionModeToggle: false,
} as const;

const CHATGPT_BROWSER_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [],
});

const CHATGPT_BROWSER_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "chatgpt",
    name: "ChatGPT (browser)",
    shortName: "ChatGPT",
    isCustom: false,
    capabilities: CHATGPT_BROWSER_MODEL_CAPABILITIES,
  },
];

const BrowserVersionResponse = Schema.Struct({
  Browser: Schema.optional(Schema.String),
  browser: Schema.optional(Schema.String),
});

function cdpVersionUrl(endpoint: string): string | undefined {
  const trimmed = endpoint.trim();
  if (!trimmed || trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    url.pathname = "/json/version";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeProbeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return String(error);
}

function configuredLaunchMessage(settings: ChatGptBrowserSettings): string {
  const executablePath = nonEmptyTrimmed(settings.browserExecutablePath);
  if (!executablePath) {
    return `Connects to a browser debugging endpoint at ${settings.cdpEndpoint}. Start Chrome or Chromium with remote debugging and keep a logged-in chatgpt.com tab available.`;
  }
  return `Will launch a visible browser from ${executablePath} on first use. Log in to chatgpt.com in that browser profile before sending work.`;
}

export const makePendingChatGptBrowserProvider = (
  settings: ChatGptBrowserSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);

    return buildServerProvider({
      presentation: CHATGPT_BROWSER_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: CHATGPT_BROWSER_MODELS,
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "ChatGPT browser connector status has not been checked in this session yet."
          : "ChatGPT browser connector is disabled in SergeCode settings.",
      },
    });
  });

export const checkChatGptBrowserProviderStatus = Effect.fn("checkChatGptBrowserProviderStatus")(
  function* (
    settings: ChatGptBrowserSettings,
  ): Effect.fn.Return<ServerProviderDraft, never, HttpClient.HttpClient> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const httpClient = yield* HttpClient.HttpClient;

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: CHATGPT_BROWSER_PRESENTATION,
        enabled: false,
        checkedAt,
        models: CHATGPT_BROWSER_MODELS,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "ChatGPT browser connector is disabled in SergeCode settings.",
        },
      });
    }

    const executablePath = nonEmptyTrimmed(settings.browserExecutablePath);
    if (executablePath) {
      return buildServerProvider({
        presentation: CHATGPT_BROWSER_PRESENTATION,
        enabled: true,
        checkedAt,
        models: CHATGPT_BROWSER_MODELS,
        probe: {
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "unknown", type: "browser" },
          message: configuredLaunchMessage(settings),
        },
      });
    }

    const versionUrl = cdpVersionUrl(settings.cdpEndpoint);
    if (!versionUrl) {
      return buildServerProvider({
        presentation: CHATGPT_BROWSER_PRESENTATION,
        enabled: true,
        checkedAt,
        models: CHATGPT_BROWSER_MODELS,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown", type: "browser" },
          message:
            "A WebSocket CDP endpoint is configured. SergeCode will connect to it when a ChatGPT session starts.",
        },
      });
    }

    const result = yield* httpClient
      .execute(HttpClientRequest.get(versionUrl).pipe(HttpClientRequest.acceptJson))
      .pipe(
        Effect.flatMap(
          HttpClientResponse.matchStatus({
            "2xx": (response) =>
              HttpClientResponse.schemaBodyJson(BrowserVersionResponse)(response),
            orElse: (response) =>
              Effect.fail(
                new ProviderValidationError({
                  operation: "chatgpt.browser.versionProbe",
                  issue: `HTTP ${response.status}`,
                }),
              ),
          }),
        ),
        Effect.timeout("2500 millis"),
        Effect.result,
      );

    if (result._tag === "Failure") {
      return buildServerProvider({
        presentation: CHATGPT_BROWSER_PRESENTATION,
        enabled: true,
        checkedAt,
        models: CHATGPT_BROWSER_MODELS,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown", type: "browser" },
          message: `Couldn't reach the configured browser debugging endpoint at ${settings.cdpEndpoint}: ${normalizeProbeError(result.failure)}. Start Chrome/Chromium with --remote-debugging-port or configure a browser executable path.`,
        },
      });
    }

    return buildServerProvider({
      presentation: CHATGPT_BROWSER_PRESENTATION,
      enabled: true,
      checkedAt,
      models: CHATGPT_BROWSER_MODELS,
      probe: {
        installed: true,
        version: result.success.Browser ?? result.success.browser ?? null,
        status: "ready",
        auth: { status: "unknown", type: "browser" },
        message: configuredLaunchMessage(settings),
      },
    });
  },
);
