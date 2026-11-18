import {
  EnvironmentId,
  InferenceDriver,
  INFERENCE_HARNESSES,
  isInferenceProviderConfig,
  type CustomModelSetting,
  type ServerProviderModel,
  type SettingsSecretValue,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Equal from "effect/Equal";
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

export const isRetryableInferenceStatus = (status: number): boolean =>
  [401, 403, 429, 502, 503, 529].includes(status);

export function inferenceRetryDelayMs(
  retryAfter: string | undefined,
  retryAfterMs: string | undefined,
  now: number,
) {
  const numericDelay = (value: string | undefined, scale: number) => {
    if (!value?.trim()) return undefined;
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return undefined;
    const delay = amount * scale;
    return Number.isSafeInteger(Math.ceil(delay)) ? Math.ceil(delay) : undefined;
  };
  const millis = numericDelay(retryAfterMs, 1);
  const seconds = retryAfter?.trim() ? Number(retryAfter) : Number.NaN;
  const standard = Number.isFinite(seconds)
    ? numericDelay(retryAfter, 1000)
    : retryAfter
      ? Date.parse(retryAfter) - now
      : undefined;
  return (
    millis ??
    (standard !== undefined && Number.isFinite(standard) && standard >= 0 ? standard : undefined)
  );
}

export function inferenceTarget(method: string, rawUrl: string) {
  const bridge = /^\/api\/inference\/traex\/(host|resolve)(\/v1\/[^?]+)$/.exec(rawUrl);
  if (bridge) {
    const [scope, path] = [bridge[1], bridge[2]];
    if (
      (scope === "host" || scope === "resolve") &&
      ((method === "GET" && path === "/v1/models") ||
        (method === "POST" && (path === "/v1/responses" || path === "/v1/responses/compact")))
    )
      return { traex: scope, path, environmentId: undefined } as const;
    return null;
  }
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

export interface ProxyAccount {
  readonly id?: string | undefined;
  readonly name: string;
  readonly provider?: string | undefined;
  readonly status: string;
  readonly disabled?: boolean | undefined;
  readonly unavailable?: boolean | undefined;
  readonly runtime_only?: boolean | undefined;
  readonly cooldowns?:
    | ReadonlyArray<{
        readonly scope: string;
        readonly model_key?: string | undefined;
        readonly retry_at: string;
      }>
    | null
    | undefined;
}

export interface AccountModelAvailability {
  readonly accounts: ReadonlyArray<ProxyAccount>;
  readonly excludedNames: ReadonlySet<string>;
  readonly registeredModels: ReadonlyMap<string, readonly string[]>;
  readonly now: number;
}

const usableAccount = (account: ProxyAccount, excludedNames: ReadonlySet<string>) =>
  account.status === "active" &&
  !account.disabled &&
  !account.unavailable &&
  !excludedNames.has(account.name);

const activeCooldowns = (account: ProxyAccount, now: number) =>
  account.cooldowns?.filter((cooldown) => Date.parse(cooldown.retry_at) > now) ?? [];

export function needsAccountModelLookup(
  accounts: ReadonlyArray<ProxyAccount>,
  excludedNames: ReadonlySet<string>,
  now: number,
) {
  return accounts.some(
    (account) => !usableAccount(account, excludedNames) || activeCooldowns(account, now).length > 0,
  );
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
// GPT Image IDs are selected by the image tool or Images API, not as chat models.
const isGptImageModel = (id: string) => /^gpt-image(?:-|$)/i.test(id);
const ownedBy = (vendor: string, pattern: RegExp) => (model: ProxyModel) => {
  const owner = model.owned_by?.toLowerCase();
  return owner !== undefined && VENDORS.includes(owner) ? owner === vendor : pattern.test(model.id);
};
// Codex reports stream retries to the thread. Its inner HTTP retries can wait silently for minutes.
const CODEX_PROVIDER = (baseUrl: string) =>
  `model_providers.t3proxy={name="T3 inference",base_url="${baseUrl}/v1",env_key="T3_INFERENCE_KEY",wire_api="responses",request_max_retries=0,supports_websockets=false,requires_openai_auth=false}`;

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

export function modelsForDriver(
  data: readonly ProxyModel[],
  driver: InferenceDriver,
  availability?: AccountModelAvailability,
) {
  const models = data.filter(
    (model) => !isGptImageModel(model.id) && harnesses[driver].serves(model),
  );
  const modelIds = [...new Set(models.map((model) => model.id))];
  if (
    !availability ||
    !needsAccountModelLookup(availability.accounts, availability.excludedNames, availability.now)
  )
    return modelIds;
  const available = new Set<string>();
  for (const account of availability.accounts) {
    if (!usableAccount(account, availability.excludedNames)) continue;
    const cooldowns = activeCooldowns(account, availability.now);
    if (cooldowns.some((cooldown) => cooldown.scope === "credential")) continue;
    const blocked = new Set(
      cooldowns
        .filter((cooldown) => cooldown.scope === "model" && cooldown.model_key)
        .map((cooldown) => cooldown.model_key),
    );
    const registered = availability.registeredModels.get(account.id || account.name);
    if (registered === undefined) {
      const owner =
        account.provider === "codex"
          ? "openai"
          : account.provider === "claude"
            ? "anthropic"
            : null;
      if (
        owner &&
        availability.accounts.filter((other) => other.provider === account.provider).length === 1
      ) {
        for (const model of models) {
          if (model.owned_by === owner && !blocked.has(model.id)) available.add(model.id);
        }
      }
      continue;
    }
    for (const model of registered) {
      if (!blocked.has(model)) available.add(model);
    }
  }
  return modelIds.filter((id) => available.has(id));
}

export function routeProvider(driver: InferenceDriver, label: string | null, route: Route) {
  const harness = harnesses[driver];
  const name = INFERENCE_HARNESSES[driver].label;
  const chatRoute = {
    ...route,
    models: [...new Set(route.models.filter((id) => !isGptImageModel(id)))],
  };
  return {
    displayName: label === null ? name : `${name} via ${label}`,
    config: harness.config(chatRoute),
    environment: harness.environment(chatRoute),
  };
}

export function isOpenCodeInferenceCatalogChange(
  previous: ProviderInstanceConfig,
  next: ProviderInstanceConfig,
): boolean {
  const current = previous.config;
  const updated = next.config;
  if (
    previous.driver !== "opencode" ||
    !isInferenceProviderConfig(current) ||
    !current.inferenceEnabled ||
    !isInferenceProviderConfig(updated) ||
    Equal.equals(current.inferenceModels, updated.inferenceModels)
  )
    return false;
  const environment = previous.environment;
  const content = environment?.find(({ name }) => name === "OPENCODE_CONFIG_CONTENT");
  const nativeContent = content?.value;
  if (environment === undefined || typeof nativeContent !== "string") return false;
  const generated = routeProvider("opencode", null, {
    baseUrl: current.inferenceBaseUrl,
    key: current.inferenceKey,
    models: updated.inferenceModels,
    homePath: current.inferenceHomePath,
    current: () => nativeContent,
  }).environment.find(({ name }) => name === "OPENCODE_CONFIG_CONTENT");
  return Equal.equals(
    {
      ...previous,
      config: { ...current, inferenceModels: updated.inferenceModels },
      environment: environment.map((entry) => (entry === content ? generated : entry)),
    },
    next,
  );
}

export function inferenceModelSlugs(config: {
  setupMode?: string;
  customModels: readonly CustomModelSetting[];
}) {
  return config.setupMode === "inference"
    ? new Set(config.customModels.map((entry) => (typeof entry === "string" ? entry : entry.slug)))
    : null;
}

export function withInferenceModelCatalog(
  models: ReadonlyArray<ServerProviderModel>,
  hostedSlugs: ReadonlySet<string> | null,
): ReadonlyArray<ServerProviderModel> {
  if (!hostedSlugs) return models;
  // Codex and Claude ingest host discoveries through their custom model config.
  return models
    .filter((model) => hostedSlugs.has(model.slug))
    .map((model) =>
      model.isCustom
        ? {
            ...model,
            name: model.name === model.slug ? formatModelSlugName(model.slug) : model.name,
            isCustom: false,
          }
        : model,
    );
}
