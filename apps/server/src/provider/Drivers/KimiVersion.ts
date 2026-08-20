import type { KimiSettings } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import { spawnAndCollect } from "../providerSnapshot.ts";

export const MINIMUM_KIMI_THINKING_LEVELS_VERSION = "0.29.0";

export function parseKimiCliVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)\b/);
  return match?.[1] ?? null;
}

export function getKimiCliCompatibilityIssue(version: string | null): string | null {
  if (version === null) {
    return `Unable to determine Kimi version from \`kimi --version\` output. T3 Code requires Kimi v${MINIMUM_KIMI_THINKING_LEVELS_VERSION} or newer.`;
  }
  if (compareSemverVersions(version, MINIMUM_KIMI_THINKING_LEVELS_VERSION) < 0) {
    return `Kimi CLI v${version} is too old. Upgrade to v${MINIMUM_KIMI_THINKING_LEVELS_VERSION} or newer to use selectable thinking levels.`;
  }
  return null;
}

export const runKimiVersionCommand = (
  settings: Pick<KimiSettings, "binaryPath">,
  environment?: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "kimi";
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      ["--version"],
      environment ? { env: environment } : {},
    );
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(environment ? { env: environment } : {}),
        shell: spawnCommand.shell,
      }),
    );
  });
