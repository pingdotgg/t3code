import { ClaudeSettings, type OpenRouterSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const OPENROUTER_DRIVER_KIND = ProviderDriverKind.make("openrouter");
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api";
export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

/**
 * Anthropic-compat credential env vars that OpenRouter owns for the Claude
 * Code runtime. Always overwritten (never inherited from the host process).
 */
const OPENROUTER_OWNED_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENROUTER_API_KEY",
  "HTTP_REFERER",
  "X_TITLE",
  // Legacy aliases that must not leak from the host into OpenRouter sessions.
  "OR_SITE_URL",
  "OR_APP_NAME",
] as const;

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

/**
 * Narrow Claude runtime config needed by `makeClaudeAdapter` / text generation.
 * OpenRouter does not expose Claude homePath / launchArgs in its settings.
 */
export function toClaudeSettings(settings: OpenRouterSettings): ClaudeSettings {
  return decodeClaudeSettings({
    enabled: settings.enabled,
    binaryPath: settings.binaryPath,
    homePath: "",
    customModels: settings.customModels,
    launchArgs: "",
  });
}

/**
 * Build the process env for OpenRouter-backed Claude Code sessions.
 *
 * Matches OpenRouter's Claude Code contract:
 * - `ANTHROPIC_BASE_URL` → OpenRouter Anthropic skin (`https://openrouter.ai/api`)
 * - `ANTHROPIC_AUTH_TOKEN` → OpenRouter API key
 * - `ANTHROPIC_API_KEY` → always `""` so Claude Code does not prefer a host Anthropic key
 *
 * Owned credential/attribution keys are always cleared first so host values cannot leak
 * when settings omit them.
 */
export function buildOpenRouterProcessEnv(
  settings: OpenRouterSettings,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of OPENROUTER_OWNED_ENV_KEYS) {
    delete next[key];
  }

  const baseUrl = normalizeOpenRouterBaseUrl(settings.baseUrl);
  const apiKey = settings.apiKey.trim();

  next.ANTHROPIC_BASE_URL = baseUrl;
  // Critical: empty string (not unset) so Claude Code does not fall back to Anthropic auth.
  next.ANTHROPIC_API_KEY = "";

  if (apiKey.length > 0) {
    next.ANTHROPIC_AUTH_TOKEN = apiKey;
    next.OPENROUTER_API_KEY = apiKey;
  } else {
    next.ANTHROPIC_AUTH_TOKEN = "";
    next.OPENROUTER_API_KEY = "";
  }

  const httpReferer = settings.httpReferer.trim();
  if (httpReferer.length > 0) {
    next.HTTP_REFERER = httpReferer;
  }

  const appTitle = settings.appTitle.trim();
  if (appTitle.length > 0) {
    next.X_TITLE = appTitle;
  }

  return next;
}
