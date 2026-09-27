import type { DevinSettings } from "@t3tools/contracts";

import type { AcpSpawnInput } from "./AcpSessionRuntime.ts";

export function buildDevinAcpSpawnInput(
  settings: Pick<DevinSettings, "binaryPath">,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  return {
    command: settings.binaryPath,
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}
