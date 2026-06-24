// @effect-diagnostics globalFetchInEffect:off
import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
  type T3ChatSettings,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { T3ChatBridgeError, T3ChatRuntime } from "../t3chatRuntime.ts";
import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const DRIVER_KIND = ProviderDriverKind.make("t3chat");

interface T3ChatModel {
  id: string;
  label: string;
  provider: string;
}

const PROVIDER_ORDER = [
  "Claude",
  "GPT",
  "Gemini",
  "DeepSeek",
  "Grok",
  "Kimi",
  "Qwen",
  "Llama",
];
const T3CHAT_STATUS_TIMEOUT = Duration.seconds(10);

const BRAND_CASING: Record<string, string> = {
  gpt: "GPT",
  glm: "GLM",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  mimo: "MiMo",
};

function formatModelId(id: string): string {
  return id
    .split("-")
    .map((part) => {
      const lower = part.toLowerCase();
      if (BRAND_CASING[lower]) return BRAND_CASING[lower];
      if (lower === "thinking" || lower === "reasoning") {
        return `(${part.charAt(0).toUpperCase() + part.slice(1)})`;
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function detectProvider(id: string): string {
  const lower = id.toLowerCase();
  if (lower.startsWith("claude")) return "Claude";
  if (
    lower.startsWith("gpt") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  )
    return "GPT";
  if (lower.startsWith("gemini") || lower.startsWith("gemma")) return "Gemini";
  if (lower.startsWith("deepseek")) return "DeepSeek";
  if (lower.startsWith("grok")) return "Grok";
  if (lower.startsWith("kimi")) return "Kimi";
  if (lower.startsWith("qwen")) return "Qwen";
  if (lower.startsWith("llama")) return "Llama";
  if (lower.startsWith("glm")) return "GLM";
  if (lower.startsWith("minimax")) return "MiniMax";
  if (lower.startsWith("mimo")) return "MiMo";
  return "Other";
}

const FALLBACK_MODELS: T3ChatModel[] = [
  { id: "claude-4-sonnet", label: "Claude 4 Sonnet", provider: "Claude" },
  { id: "claude-4-opus", label: "Claude 4 Opus", provider: "Claude" },
  { id: "gpt-4.1", label: "GPT 4.1", provider: "GPT" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "Gemini" },
  { id: "deepseek-r1", label: "DeepSeek R1", provider: "DeepSeek" },
  { id: "grok-3", label: "Grok 3", provider: "Grok" },
];

const T3CHAT_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "effort",
      label: "Reasoning",
      options: [
        { value: "none", label: "None" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "high", label: "High" },
      ],
    }),
    buildBooleanOptionDescriptor({
      id: "includeSearch",
      label: "Search",
      currentValue: false,
    }),
  ],
});

function toServerModels(models: T3ChatModel[]): ServerProviderModel[] {
  return models.map((m) => ({
    slug: m.id,
    name: m.label,
    subProvider: m.provider,
    isCustom: false,
    capabilities: T3CHAT_MODEL_CAPABILITIES,
  }));
}

function buildBridgeAuthLabel(settings: T3ChatSettings): string {
  return settings.serverUrl?.trim()
    ? "T3 Chat bridge connected through external server"
    : "T3 Chat bridge authenticated with configured cookies";
}

function parseBridgeModels(data: unknown): T3ChatModel[] {
  const arr = data as { result?: { data?: { json?: unknown } } } | undefined;
  const benchmarks = arr?.result?.data?.json;
  if (!benchmarks || typeof benchmarks !== "object") {
    throw new T3ChatBridgeError({
      operation: "parseBridgeModels",
      detail: "Bridge returned invalid model payload.",
    });
  }

  const models: T3ChatModel[] = Object.keys(
    benchmarks as Record<string, unknown>,
  ).map((id) => ({
    id,
    label: formatModelId(id),
    provider: detectProvider(id),
  }));

  models.sort((a, b) => {
    const ai = PROVIDER_ORDER.indexOf(a.provider);
    const bi = PROVIDER_ORDER.indexOf(b.provider);
    const ao = ai === -1 ? PROVIDER_ORDER.length : ai;
    const bo = bi === -1 ? PROVIDER_ORDER.length : bi;
    if (ao !== bo) return ao - bo;
    return b.id.localeCompare(a.id);
  });

  return models;
}

const fetchModelsFromBridge = Effect.fn("fetchModelsFromBridge")(function* (
  bridgeURL: string,
) {
  const response = yield* Effect.tryPromise({
    try: () => fetch(`${bridgeURL}/models`),
    catch: () =>
      new T3ChatBridgeError({
        operation: "fetchModelsFromBridge",
        detail: "Failed to fetch T3 Chat models.",
      }),
  });

  if (!response.ok) {
    return yield* new T3ChatBridgeError({
      operation: "fetchModelsFromBridge",
      detail: `Bridge /models returned ${response.status}.`,
    });
  }

  const payload = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: () =>
      new T3ChatBridgeError({
        operation: "fetchModelsFromBridge",
        detail: "Failed to parse bridge model JSON.",
      }),
  });

  return parseBridgeModels(payload);
});

const checkBridgeAuth = Effect.fn("checkBridgeAuth")(function* (
  bridgeURL: string,
) {
  const response = yield* Effect.tryPromise({
    try: () => fetch(`${bridgeURL}/auth/check`),
    catch: () =>
      new T3ChatBridgeError({
        operation: "checkBridgeAuth",
        detail: "Failed to verify T3 Chat bridge auth.",
      }),
  });

  const payload = yield* Effect.tryPromise({
    try: () => response.json() as Promise<{ ok?: boolean; status?: number }>,
    catch: () =>
      new T3ChatBridgeError({
        operation: "checkBridgeAuth",
        detail: "Failed to parse bridge auth response.",
      }),
  });

  return {
    ok: payload.ok === true,
    status:
      typeof payload.status === "number" ? payload.status : response.status,
  };
});

export const makePendingT3ChatProvider = (
  settings: T3ChatSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const hasAuth = !!settings.wosSession && !!settings.convexSessionId;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);

    return buildServerProvider({
      driver: DRIVER_KIND,
      presentation: { displayName: "T3 Chat", showInteractionModeToggle: false },
      enabled: settings.enabled,
      checkedAt,
      models: toServerModels(FALLBACK_MODELS),
      probe: {
        installed: false,
        version: null,
        status: hasAuth ? "warning" : "warning",
        auth: {
          status: hasAuth ? "unknown" : "unauthenticated",
          type: "cookie",
          ...(!hasAuth
            ? {
                label:
                  "Configure wosSession and convexSessionId in provider settings",
              }
            : {}),
        },
        message: hasAuth
          ? "T3 Chat bridge status has not been checked in this session yet."
          : "T3 Chat credentials not configured",
      },
    });
  });

export const checkT3ChatProviderStatus = (
  settings: T3ChatSettings,
): Effect.Effect<ServerProviderDraft, never, T3ChatRuntime> =>
  Effect.gen(function* () {
    const t3ChatRuntime = yield* T3ChatRuntime;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const hasAuth = !!settings.wosSession && !!settings.convexSessionId;

    const versionResult = settings.serverUrl?.trim()
      ? Result.succeed("external")
      : yield* t3ChatRuntime
          .runT3ChatBridgeVersionCheck({
            binaryPath: settings.binaryPath,
          })
          .pipe(Effect.timeout(T3CHAT_STATUS_TIMEOUT), Effect.result);

    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      const isMissingBinary =
        error instanceof T3ChatBridgeError &&
        error.detail.toLowerCase().includes("enoent");
      return buildServerProvider({
        driver: DRIVER_KIND,
        presentation: { displayName: "T3 Chat", showInteractionModeToggle: false },
        enabled: settings.enabled,
        checkedAt,
        models: toServerModels(FALLBACK_MODELS),
        probe: {
          installed: settings.serverUrl?.trim() ? true : !isMissingBinary,
          version: null,
          status: "error",
          auth: {
            status: hasAuth ? "unknown" : "unauthenticated",
            type: "cookie",
          },
          message: settings.serverUrl?.trim()
            ? `Failed to use external T3 Chat bridge: ${error.message}`
            : isMissingBinary
              ? "T3 Chat bridge binary (`t3chat-bridge`) is not installed or not on PATH."
              : `T3 Chat bridge probe failed: ${error.message}`,
        },
      });
    }

    const bridgeVersion = settings.serverUrl?.trim()
      ? null
      : Result.isSuccess(versionResult)
        ? versionResult.success
        : null;

    if (!hasAuth) {
      return buildServerProvider({
        driver: DRIVER_KIND,
        presentation: { displayName: "T3 Chat", showInteractionModeToggle: false },
        enabled: settings.enabled,
        checkedAt,
        models: toServerModels(FALLBACK_MODELS),
        probe: {
          installed: true,
          version: bridgeVersion,
          status: "warning",
          auth: {
            status: "unauthenticated",
            type: "cookie",
            label:
              "Configure wosSession and convexSessionId in provider settings",
          },
          message: "T3 Chat credentials not configured",
        },
      });
    }

    const bridgeProbeResult = yield* Effect.scoped(
      Effect.gen(function* () {
        const bridge = yield* t3ChatRuntime.connectToT3ChatBridge({
          binaryPath: settings.binaryPath,
          serverUrl: settings.serverUrl,
          wosSession: settings.wosSession,
          convexSessionId: settings.convexSessionId,
        });
        const auth = yield* checkBridgeAuth(bridge.url);
        const models = yield* fetchModelsFromBridge(bridge.url).pipe(
          Effect.catch(() => Effect.succeed(FALLBACK_MODELS)),
        );
        return { auth, models };
      }),
    ).pipe(Effect.timeoutOption(T3CHAT_STATUS_TIMEOUT), Effect.result);

    if (Result.isFailure(bridgeProbeResult)) {
      return buildServerProvider({
        driver: DRIVER_KIND,
        presentation: { displayName: "T3 Chat", showInteractionModeToggle: false },
        enabled: settings.enabled,
        checkedAt,
        models: toServerModels(FALLBACK_MODELS),
        probe: {
          installed: true,
          version: bridgeVersion,
          status: "error",
          auth: { status: "unknown", type: "cookie" },
          message: `T3 Chat bridge probe failed: ${bridgeProbeResult.failure.message}`,
        },
      });
    }

    if (Option.isNone(bridgeProbeResult.success)) {
      return buildServerProvider({
        driver: DRIVER_KIND,
        presentation: { displayName: "T3 Chat", showInteractionModeToggle: false },
        enabled: settings.enabled,
        checkedAt,
        models: toServerModels(FALLBACK_MODELS),
        probe: {
          installed: true,
          version: bridgeVersion,
          status: "error",
          auth: { status: "unknown", type: "cookie" },
          message: "Timed out while checking T3 Chat bridge status.",
        },
      });
    }

    const { auth, models } = bridgeProbeResult.success.value;
    const isAuthenticated = auth.ok;
    const probe = {
      installed: true,
      version: bridgeVersion,
      status: isAuthenticated ? ("ready" as const) : ("error" as const),
      auth: {
        status: isAuthenticated
          ? ("authenticated" as const)
          : ("unauthenticated" as const),
        type: "cookie" as const,
        ...(isAuthenticated ? { label: buildBridgeAuthLabel(settings) } : {}),
      } satisfies ServerProvider["auth"],
      ...(!isAuthenticated
        ? {
            message:
              auth.status === 401 || auth.status === 403
                ? "Authentication failed. Your T3 Chat session cookies may have expired."
                : `T3 Chat bridge auth check returned status ${auth.status}.`,
          }
        : {}),
    };

    return buildServerProvider({
      driver: DRIVER_KIND,
      presentation: { displayName: "T3 Chat", showInteractionModeToggle: false },
      enabled: settings.enabled,
      checkedAt,
      models: toServerModels(models),
      probe,
    });
  });
