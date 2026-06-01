import {
  PROJECT_CONFIG_RELATIVE_PATH,
  PROJECT_CONFIG_SCHEMA_URL,
  type ProjectScript,
} from "@t3tools/contracts";

import { normalizeBrowserAgentPreviewUrl } from "./browserAgents";

type JsonObject = Record<string, unknown>;

export interface ProjectConfigFileUpdate {
  readonly scripts?: readonly ProjectScript[] | undefined;
  readonly browserPreviewUrl?: string | null | undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProjectConfigJson(contents: string | null | undefined): JsonObject {
  const trimmedContents = contents?.trim() ?? "";
  if (trimmedContents.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmedContents) as unknown;
    if (!isJsonObject(parsed)) {
      throw new Error("Project config must be a JSON object.");
    }
    return { ...parsed };
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Invalid ${PROJECT_CONFIG_RELATIVE_PATH}: ${error.message}`
        : `Invalid ${PROJECT_CONFIG_RELATIVE_PATH}.`,
      { cause: error },
    );
  }
}

function normalizedPreviewUrl(rawUrl: string | null): string | null {
  if (rawUrl === null) {
    return null;
  }
  const normalized = normalizeBrowserAgentPreviewUrl(rawUrl);
  return normalized.length > 0 ? normalized : null;
}

function applyBrowserPreviewUrl(config: JsonObject, rawUrl: string | null): void {
  const previewUrl = normalizedPreviewUrl(rawUrl);
  const browser = isJsonObject(config.browser) ? { ...config.browser } : {};

  if (previewUrl === null) {
    delete browser.previewUrl;
  } else {
    browser.previewUrl = previewUrl;
  }

  if (Object.keys(browser).length === 0) {
    delete config.browser;
  } else {
    config.browser = browser;
  }
}

export function updateProjectConfigJson(
  contents: string | null | undefined,
  update: ProjectConfigFileUpdate,
): string {
  const config = parseProjectConfigJson(contents);
  config.$schema = typeof config.$schema === "string" ? config.$schema : PROJECT_CONFIG_SCHEMA_URL;

  if (update.browserPreviewUrl !== undefined) {
    applyBrowserPreviewUrl(config, update.browserPreviewUrl);
  }

  if (update.scripts !== undefined) {
    config.scripts = [...update.scripts];
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}
