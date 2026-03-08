import type { AssistantDeliveryMode, ProviderKind } from "@t3tools/contracts";

import { getAppSettingsSnapshot, type AppSettings } from "../appSettings";

export function getProviderOptionsForDispatch(
  settings: Pick<AppSettings, "claudeBinaryPath" | "claudeHomePath" | "codexBinaryPath" | "codexHomePath">,
  provider: ProviderKind,
) {
  const providerSettings =
    provider === "claudeCode"
      ? {
          binaryPath: settings.claudeBinaryPath,
          homePath: settings.claudeHomePath,
        }
      : {
          binaryPath: settings.codexBinaryPath,
          homePath: settings.codexHomePath,
        };
  const normalizedOptions = {
    ...(providerSettings.binaryPath ? { binaryPath: providerSettings.binaryPath } : {}),
    ...(providerSettings.homePath ? { homePath: providerSettings.homePath } : {}),
  };

  if (Object.keys(normalizedOptions).length === 0) {
    return undefined;
  }

  return provider === "claudeCode"
    ? { claudeCode: normalizedOptions }
    : { codex: normalizedOptions };
}

export function getAssistantDeliveryModeForDispatch(
  settings: Pick<AppSettings, "enableAssistantStreaming">,
): AssistantDeliveryMode {
  return settings.enableAssistantStreaming ? "streaming" : "buffered";
}

export function getSendTimeAssistantDeliveryMode(): AssistantDeliveryMode {
  return getAssistantDeliveryModeForDispatch(getAppSettingsSnapshot());
}