import { ClaudeSettings, type OpenRouterSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const OPENROUTER_DRIVER_KIND = ProviderDriverKind.make("openrouter");
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api";
export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

export function normalizeOpenRouterBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const normalized = (trimmed.length > 0 ? trimmed : DEFAULT_OPENROUTER_BASE_URL).replace(
    /\/+$/,
    "",
  );
  return normalized;
}

export function openRouterModelsUrl(baseUrl: string): string {
  return `${normalizeOpenRouterBaseUrl(baseUrl)}/v1/models?supported_parameters=tools`;
}

export function toClaudeSettings(settings: OpenRouterSettings): ClaudeSettings {
  return decodeClaudeSettings({
    enabled: settings.enabled,
    binaryPath: settings.binaryPath,
    homePath: "",
    customModels: settings.customModels,
    launchArgs: "",
  });
}

export function buildOpenRouterProcessEnv(
  settings: OpenRouterSettings,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  const baseUrl = normalizeOpenRouterBaseUrl(settings.baseUrl);
  const apiKey = settings.apiKey.trim();

  next.ANTHROPIC_BASE_URL = baseUrl;
  if (apiKey.length > 0) {
    next.ANTHROPIC_API_KEY = apiKey;
    next.OPENROUTER_API_KEY = apiKey;
  }

  const httpReferer = settings.httpReferer.trim();
  if (httpReferer.length > 0) {
    next.HTTP_REFERER = httpReferer;
    next.OR_SITE_URL = httpReferer;
  }

  const appTitle = settings.appTitle.trim();
  if (appTitle.length > 0) {
    next.X_TITLE = appTitle;
    next.OR_APP_NAME = appTitle;
  }

  return next;
}
