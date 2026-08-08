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
  /** The default slot (instance id === driver kind) or the legacy blob. */
  readonly isDefault: boolean;
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
    // Any entry occupying the default slot claims it, even one for another
    // driver: the registry suppresses the legacy blob in that case too.
    if (instanceId === driver) defaultSlotClaimed = true;
    if (envelope.driver !== driver) continue;
    candidates.push({
      // An envelope without a config payload is an instance running on driver
      // defaults; the settings schemas fill those in when the blob decodes.
      config: envelope.config ?? {},
      label: envelope.displayName ?? (instanceId === driver ? null : instanceId),
      isDefault: instanceId === driver,
    });
  }

  if (!defaultSlotClaimed) {
    candidates.push({ config: settings.providers[driver], label: null, isDefault: true });
  }
  return candidates;
}

/** One candidate whose home directory has been resolved on this machine. */
export interface ResolvedUsageHome {
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly label: string | null;
  /** False for a shadow overlay, which shares another instance's home. */
  readonly isDirect: boolean;
  readonly isDefault: boolean;
}

export interface UsageTranscriptDir {
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly label: string | null;
}

/**
 * Collapses candidates that resolved to the same directory into one scan
 * entry, keeping input order.
 *
 * Label precedence when several instances share a directory: a direct
 * instance beats a shadow overlay (overlays share another instance's home),
 * and the default slot beats named extras — a config-less extra instance
 * resolves to the same home as the default, and that home's usage should
 * render under the plain provider name, not the extra's.
 */
export function dedupeUsageHomes(
  homes: readonly ResolvedUsageHome[],
): readonly UsageTranscriptDir[] {
  const rank = (home: ResolvedUsageHome) => (home.isDirect ? 2 : 0) + (home.isDefault ? 1 : 0);

  const byKey = new Map<string, { entry: { label: string | null }; rank: number }>();
  const dirs: { provider: UsageProviderKind; dir: string; label: string | null }[] = [];

  for (const home of homes) {
    const key = `${home.provider}\0${home.dir}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      const entry = { provider: home.provider, dir: home.dir, label: home.label };
      byKey.set(key, { entry, rank: rank(home) });
      dirs.push(entry);
      continue;
    }
    if (rank(home) > existing.rank) {
      existing.entry.label = home.label;
      existing.rank = rank(home);
    }
  }

  return dirs;
}
