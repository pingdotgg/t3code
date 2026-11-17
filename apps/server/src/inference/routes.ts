import {
  EnvironmentId,
  InferenceDriver,
  INFERENCE_HARNESSES,
  ProviderDriverKind,
  type CustomModelSetting,
  type SettingsSecretValue,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const PREFIX = "/api/inference";
const isInferenceDriver = Schema.is(InferenceDriver);

export function inferencePath(method: string, rawUrl: string): string | null {
  if (!rawUrl.startsWith(PREFIX)) return null;
  const path = rawUrl.slice(PREFIX.length);
  if (method === "GET" && (path === "/v1/models" || path === "/health")) return path;
  if (method !== "POST") return null;
  return [
    "/v1/responses",
    "/v1/responses/compact",
    "/v1/chat/completions",
    "/v1/messages",
    "/v1/messages/count_tokens",
    "/v1/messages?beta=true",
    "/v1/messages/count_tokens?beta=true",
  ].includes(path)
    ? path
    : null;
}

export function inferenceTarget(method: string, rawUrl: string) {
  const linked = /^\/api\/inference\/linked\/([^/]+)\/([^/]+)(\/.*)$/.exec(rawUrl);
  const driver = linked && isInferenceDriver(linked[1]) ? linked[1] : undefined;
  if (rawUrl.startsWith(PREFIX + "/linked/") && !driver) return null;
  const path = inferencePath(method, linked ? PREFIX + linked[3] : rawUrl);
  if (!path) return null;
  if (!linked) return { path, environmentId: undefined };
  try {
    return {
      path,
      environmentId: EnvironmentId.make(decodeURIComponent(linked[2]!)),
      driver,
    };
  } catch {
    return null;
  }
}

export function validateRouteUrl(value: string, local: boolean): boolean {
  const url = URL.parse(value);
  if (!url || url.origin + (local ? "" : PREFIX) !== value) return false;
  return local
    ? url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== ""
    : (url.protocol === "https:" && /^[a-z0-9.-]+\.ts\.net$/u.test(url.hostname)) ||
        (url.protocol === "http:" &&
          /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) &&
          /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname));
}

export interface ProxyModel {
  readonly id: string;
  readonly owned_by?: string | undefined;
}

interface Route {
  readonly baseUrl: string;
  readonly key: SettingsSecretValue;
  readonly models: readonly string[];
  readonly homePath: string;
  /** The instance's own value for a variable the route rewrites. */
  readonly current: (name: string) => string | undefined;
}

const blank = (names: readonly string[], value = "") =>
  names.map((name) => ({ name, value, sensitive: false }));
const VENDORS = ["openai", "anthropic"];
const ownedBy = (vendor: string, pattern: RegExp) => (model: ProxyModel) => {
  const owner = model.owned_by?.toLowerCase();
  return owner !== undefined && VENDORS.includes(owner) ? owner === vendor : pattern.test(model.id);
};
const CODEX_PROVIDER = (baseUrl: string) =>
  `model_providers.t3proxy={name="T3 inference",base_url="${baseUrl}/v1",env_key="T3_INFERENCE_KEY",wire_api="responses",supports_websockets=false,requires_openai_auth=false}`;

const configRecord = Schema.Record(Schema.String, Schema.Unknown);
const isConfigRecord = Schema.is(configRecord);
const decodeOpenCodeConfig = Schema.decodeUnknownOption(fromLenientJson(configRecord));

function parseOpenCodeConfig(content: string | undefined) {
  return decodeOpenCodeConfig(content || "{}").pipe(
    Option.filter((config) => config.provider === undefined || isConfigRecord(config.provider)),
  );
}

export function openCodeRouteProblem(
  environment: ProviderInstanceConfig["environment"],
  inheritedContent?: string,
) {
  const variable = environment?.find((entry) => entry.name === "OPENCODE_CONFIG_CONTENT");
  const unreadable =
    variable !== undefined && (variable.valueRedacted || typeof variable.value !== "string");
  const content = variable === undefined ? inheritedContent : variable.value;
  return unreadable ||
    Option.isNone(parseOpenCodeConfig(typeof content === "string" ? content : undefined))
    ? "Correct OPENCODE_CONFIG_CONTENT before using OpenCode inference routing. It must be a readable JSONC object, and its provider field must be an object."
    : null;
}

function openCodeEnvironment(route: Route) {
  const content = route.current("OPENCODE_CONFIG_CONTENT");
  const parsed = parseOpenCodeConfig(content);
  // Leave invalid native text for OpenCode to diagnose; never replace it with an empty config.
  if (Option.isNone(parsed))
    return [{ name: "OPENCODE_CONFIG_CONTENT", value: content ?? "", sensitive: false }];
  const config = parsed.value;
  const value = JSON.stringify({
    ...config,
    provider: {
      ...(isConfigRecord(config.provider) ? config.provider : {}),
      t3proxy: {
        npm: "@ai-sdk/openai-compatible",
        name: "T3 inference",
        // OpenCode substitutes the variable, so the key stays out of the config text.
        options: { baseURL: `${route.baseUrl}/v1`, apiKey: "{env:T3_INFERENCE_KEY}" },
        models: Object.fromEntries(route.models.map((model) => [model, { name: model }])),
      },
    },
  });
  return [
    { name: "T3_INFERENCE_KEY", value: route.key, sensitive: true },
    { name: "OPENCODE_CONFIG_CONTENT", value, sensitive: false },
  ];
}

/** How each routed harness reaches the proxy. */
const harnesses: Record<
  InferenceDriver,
  {
    readonly serves: (model: ProxyModel) => boolean;
    readonly config: (route: Route) => Record<string, unknown>;
    readonly environment: (
      route: Route,
    ) => ReadonlyArray<{ name: string; value: SettingsSecretValue; sensitive: boolean }>;
  }
> = {
  codex: {
    serves: ownedBy("openai", /^(codex-|gpt-|o\d)/i),
    config: (route) => ({
      setupMode: "inference",
      customModels: route.models,
      homePath: route.homePath,
      shadowHomePath: "",
      launchArgs: `-c 'model_provider="t3proxy"' -c '${CODEX_PROVIDER(route.baseUrl)}'`,
    }),
    environment: (route) => [
      { name: "T3_INFERENCE_KEY", value: route.key, sensitive: true },
      ...blank(["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "ACCESS_TOKEN"]),
      ...blank(["T3CODE_CODEX_LAUNCH_ARGS"]),
    ],
  },
  claudeAgent: {
    serves: ownedBy("anthropic", /^claude-/i),
    config: (route) => ({
      setupMode: "inference",
      customModels: route.models,
      homePath: route.homePath,
      shadowHomePath: "",
      launchArgs: "",
    }),
    environment: (route) => [
      { name: "ANTHROPIC_BASE_URL", value: route.baseUrl, sensitive: false },
      ...blank(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]),
      { name: "ANTHROPIC_AUTH_TOKEN", value: route.key, sensitive: true },
      ...blank(["ANTHROPIC_CUSTOM_HEADERS"]),
      ...blank(
        ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"],
        "0",
      ),
    ],
  },
  opencode: {
    serves: () => true,
    config: () => ({}),
    environment: openCodeEnvironment,
  },
  pi: {
    serves: () => true,
    config: () => ({}),
    environment: (route) => [
      { name: "T3_INFERENCE_KEY", value: route.key, sensitive: true },
      {
        name: "T3_PI_INFERENCE_CONFIG",
        value: JSON.stringify({ baseUrl: `${route.baseUrl}/v1`, models: route.models }),
        sensitive: false,
      },
    ],
  },
};

export function modelsForDriver(data: readonly ProxyModel[], driver: InferenceDriver) {
  return data.filter((model) => harnesses[driver].serves(model)).map((model) => model.id);
}

export function routeProvider(driver: InferenceDriver, label: string | null, route: Route) {
  const harness = harnesses[driver];
  const name = INFERENCE_HARNESSES[driver].label;
  return {
    driver: ProviderDriverKind.make(driver),
    displayName: label === null ? name : `${name} via ${label}`,
    enabled: true,
    config: harness.config(route),
    environment: harness.environment(route),
  };
}

export function inferenceModelSlugs(config: {
  setupMode?: string;
  customModels: readonly CustomModelSetting[];
}) {
  return config.setupMode === "inference"
    ? new Set(config.customModels.map((entry) => (typeof entry === "string" ? entry : entry.slug)))
    : null;
}
