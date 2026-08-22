// @effect-diagnostics nodeBuiltinImport:off
/**
 * Enumerates the provider home configurations the usage scan must cover.
 *
 * A user can configure several instances of the same driver through
 * `settings.providerInstances` (e.g. `codex_work` + `codex_personal`), each
 * with its own home directory. The scan must read every one of those homes,
 * not just the legacy single-instance `settings.providers.<kind>` blob.
 *
 * Precedence mirrors `deriveProviderInstanceConfigMap`: explicit
 * `providerInstances` entries always win, and the legacy blob only fills the
 * default slot (instance id === driver kind) when no explicit entry claims it
 * — regardless of that entry's driver, so an id claimed by another driver
 * still suppresses the legacy blob exactly as the registry does.
 *
 * @module usageHomes
 */
import * as NodePath from "node:path";

import type { ServerSettings, UsageProviderKind } from "@t3tools/contracts";

const DRIVER_BY_PROVIDER = {
  claude: "claudeAgent",
  codex: "codex",
} as const satisfies Record<UsageProviderKind, keyof ServerSettings["providers"]>;

/**
 * The provider's home environment variable. An instance can configure its
 * home purely through an environment entry; the spawned CLI honours it
 * whenever the server does not override the variable from `config.homePath`.
 */
const HOME_VARIABLE_BY_PROVIDER = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
} as const satisfies Record<UsageProviderKind, string>;

export interface UsageHomeCandidate {
  /** Raw (undecoded) driver config blob for one configured instance. */
  readonly config: unknown;
  /**
   * Effective value of the provider's home variable in the instance's spawn
   * environment, or `null`. Mirrors `mergeProviderInstanceEnvironment`: the
   * server's own environment is the base and per-instance entries override it,
   * last entry winning. Only absolute paths count — the spawn does not expand
   * `~`, and a relative path resolves against each workspace's cwd at runtime,
   * so no single directory represents it.
   */
  readonly homeEnvValue: string | null;
}

/** A home variable value the scan can actually locate on disk. */
function usableHomePath(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 && NodePath.isAbsolute(trimmed) ? trimmed : null;
}

/**
 * Candidate configs for every configured instance of the given provider.
 * Callers decode each through the driver's settings schema; blobs that fail to
 * decode belong to instances the registry already surfaces as unavailable and
 * are simply skipped by the scan.
 */
export function listProviderHomeCandidates(
  settings: ServerSettings,
  provider: UsageProviderKind,
  baseEnv: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<UsageHomeCandidate> {
  const driver = DRIVER_BY_PROVIDER[provider];
  const homeVariable = HOME_VARIABLE_BY_PROVIDER[provider];
  // Spawned CLIs inherit the server's environment, so a server-level home
  // variable applies to every instance that does not override it.
  const inheritedHome = usableHomePath(baseEnv[homeVariable]);
  const candidates: UsageHomeCandidate[] = [];
  let defaultSlotClaimed = false;

  for (const [instanceId, envelope] of Object.entries(settings.providerInstances)) {
    // Any entry occupying the default slot claims it, even one for another
    // driver: the registry suppresses the legacy blob in that case too.
    if (instanceId === driver) defaultSlotClaimed = true;
    if (envelope.driver !== driver) continue;

    let homeEnvValue = inheritedHome;
    for (const variable of envelope.environment ?? []) {
      if (variable.name !== homeVariable) continue;
      // An entry always overrides the inherited value, even to unusable: the
      // merge writes it into the spawn env verbatim.
      homeEnvValue = usableHomePath(variable.value);
    }

    candidates.push({
      // An envelope without a config payload is an instance running on driver
      // defaults; the settings schemas fill those in when the blob decodes.
      // `??`, not an `undefined` check: the registry coalesces an explicit
      // `null` payload into driver defaults the same way.
      config: envelope.config ?? {},
      homeEnvValue,
    });
  }

  if (!defaultSlotClaimed) {
    candidates.push({ config: settings.providers[driver], homeEnvValue: inheritedHome });
  }
  return candidates;
}

/**
 * The home path the scan should resolve for one candidate, mirroring the
 * runtime's precedence exactly:
 *
 *   - A configured `homePath` wins — the server overrides the home variable
 *     in the spawn environment whenever it is set.
 *   - With a shadow home, the server always sets the variable to the shadow
 *     path and sessions flow through the symlink into the shared home, so an
 *     environment entry never takes effect.
 *   - Only an instance with neither reaches the CLI with its own environment
 *     entry intact.
 */
export function scanHomePath(
  configHomePath: string,
  homeEnvValue: string | null,
  shadowed: boolean,
): string {
  if (configHomePath.trim().length > 0 || shadowed) return configHomePath;
  return homeEnvValue ?? "";
}
