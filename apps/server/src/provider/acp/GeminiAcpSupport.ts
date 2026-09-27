import type { GeminiSettings } from "@t3tools/contracts";

import type { AcpSpawnInput } from "./AcpSessionRuntime.ts";

export function buildGeminiAcpSpawnInput(
  settings: Pick<GeminiSettings, "binaryPath">,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  return {
    command: settings.binaryPath,
    args: ["--acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}
