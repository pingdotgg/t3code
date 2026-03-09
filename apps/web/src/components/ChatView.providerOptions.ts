import type { ProviderKind, ProviderSessionStartInput } from "@t3tools/contracts";

import type { AppSettings } from "../appSettings";

export function getProviderOptionsForDispatch(
  settings: Pick<
    AppSettings,
    "claudeBinaryPath" | "claudeHomePath" | "codexBinaryPath" | "codexHomePath"
  >,
  provider: ProviderKind,
): ProviderSessionStartInput["providerOptions"] | undefined {
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

  const normalized = {
    ...(providerSettings.binaryPath ? { binaryPath: providerSettings.binaryPath } : {}),
    ...(providerSettings.homePath ? { homePath: providerSettings.homePath } : {}),
  };

  if (Object.keys(normalized).length === 0) {
    return undefined;
  }

  return provider === "claudeCode" ? { claudeCode: normalized } : { codex: normalized };
}
