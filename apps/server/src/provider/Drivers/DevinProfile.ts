import * as NodeOS from "node:os";

import type { DevinSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export interface ResolvedDevinRuntimeProfile {
  /** Environment passed to every Devin process for this instance. */
  readonly environment: NodeJS.ProcessEnv;
  /** Absolute path to the Devin config file, if configured. */
  readonly configPath?: string;
  /** Stable continuation identity derived from the resolved profile. */
  readonly identity: string;
}

const DEVIN_HOME_ENV = "DEVIN_HOME";
const DEVIN_CONFIG_ENV = "DEVIN_CONFIG";

function resolveHomePath(path: Path.Path, value: string): string {
  const expanded = value.trim() ? expandHomePath(value.trim()) : NodeOS.homedir();
  return path.resolve(expanded);
}

function resolveConfigPath(path: Path.Path, value: string): string {
  return path.resolve(expandHomePath(value.trim()));
}

function buildProfileIdentity(input: {
  readonly settings: DevinSettings;
  readonly resolvedHomePath: string | undefined;
  readonly resolvedConfigPath: string | undefined;
  readonly environmentNames: ReadonlyArray<string>;
}): string {
  const parts = [
    `devin`,
    `binary=${input.settings.binaryPath.trim()}`,
    `home=${input.resolvedHomePath || "default"}`,
    `config=${input.resolvedConfigPath || ""}`,
    `agent=${input.settings.agentType.trim() || "default"}`,
    `sandbox=${input.settings.sandbox}`,
    `trust=${input.settings.respectWorkspaceTrust}`,
    ...input.environmentNames.map((name) => `env:${name}`),
  ];
  return parts.join("\0");
}

export const resolveDevinRuntimeProfile = Effect.fn("resolveDevinRuntimeProfile")(
  function* (input: {
    readonly settings: DevinSettings;
    readonly environment?: NodeJS.ProcessEnv;
  }): Effect.fn.Return<ResolvedDevinRuntimeProfile, never, Path.Path> {
    const path = yield* Path.Path;
    const settings = input.settings;
    const baseEnv = input.environment ?? process.env;

    const resolvedHomePath = settings.homePath.trim()
      ? resolveHomePath(path, settings.homePath)
      : undefined;

    const resolvedConfigPath = settings.configPath.trim()
      ? resolveConfigPath(path, settings.configPath)
      : undefined;

    const next: NodeJS.ProcessEnv = { ...baseEnv };
    if (resolvedHomePath) {
      next[DEVIN_HOME_ENV] = resolvedHomePath;
    }
    if (resolvedConfigPath) {
      next[DEVIN_CONFIG_ENV] = resolvedConfigPath;
    }

    const environmentNames = Object.entries(input.environment ?? {})
      .filter(([name]) => name.startsWith("DEVIN_") || name.startsWith("XDG_"))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}=${value ?? ""}`);

    return {
      environment: next,
      ...(resolvedConfigPath ? { configPath: resolvedConfigPath } : {}),
      identity: buildProfileIdentity({
        settings,
        resolvedHomePath,
        resolvedConfigPath,
        environmentNames,
      }),
    };
  },
);
