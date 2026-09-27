import type { MuseSettings } from "@t3tools/contracts";

import type { MspSpawnInput } from "./MspSessionHost.ts";

export function buildMuseMspSpawnInput(
  settings: Pick<MuseSettings, "binaryPath">,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): MspSpawnInput {
  return {
    command: settings.binaryPath,
    args: ["serve"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}
