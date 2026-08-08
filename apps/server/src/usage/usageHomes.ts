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
 * default slot (instance id === driver kind) when no explicit entry claims it.
 *
 * @module usageHomes
 */
import type { ServerSettings, UsageProviderKind } from "@t3tools/contracts";

const DRIVER_BY_PROVIDER = {
  claude: "claudeAgent",
  codex: "codex",
} as const satisfies Record<UsageProviderKind, keyof ServerSettings["providers"]>;

export interface UsageHomeCandidate {
  /** Raw (undecoded) driver config blob for one configured instance. */
  readonly config: unknown;
  /**
   * Display name for buckets read from this instance's home: the configured
   * `displayName`, falling back to the instance id for non-default instances.
   * `null` for the default slot and the legacy blob, whose usage should render
   * under the plain provider name.
   */
  readonly label: string | null;
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
): ReadonlyArray<UsageHomeCandidate> {
  const driver = DRIVER_BY_PROVIDER[provider];
  const candidates: UsageHomeCandidate[] = [];
  let defaultSlotClaimed = false;

  for (const [instanceId, envelope] of Object.entries(settings.providerInstances)) {
    if (envelope.driver !== driver) continue;
    if (instanceId === driver) defaultSlotClaimed = true;
    candidates.push({
      // An envelope without a config payload is an instance running on driver
      // defaults; the settings schemas fill those in when the blob decodes.
      config: envelope.config ?? {},
      label: envelope.displayName ?? (instanceId === driver ? null : instanceId),
    });
  }

  if (!defaultSlotClaimed) candidates.push({ config: settings.providers[driver], label: null });
  return candidates;
}
