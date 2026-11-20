import type { OrchestrationV2ThreadShell, ServerProvider } from "@t3tools/contracts";

export const ENGINE_KEY = "engine";

/** A release the app could install, and whether it can do that itself or only name the command. */
export interface UpdateOffer {
  readonly version: string;
  readonly canUpdate: boolean;
}

export type UpdateAction =
  /** Nothing is offered, or the update already runs or ran. */
  | "none"
  /** Offered and left to the user: the switch is off, or only a command can install it. */
  | "notify"
  /** Offered and automatic, but a run is active. */
  | "wait"
  /** Offered, automatic, and every run is idle. */
  | "start";

export interface UpdateSituation {
  readonly offer: UpdateOffer | null;
  /** The switch for this item's kind. */
  readonly automatic: boolean;
  /** An update for this release runs, or already ran this session. */
  readonly busy: boolean;
  /** Threads with an active run on this engine or provider instance. */
  readonly activeRuns: number;
}

export function decideUpdate({
  offer,
  automatic,
  busy,
  activeRuns,
}: UpdateSituation): UpdateAction {
  if (offer === null || busy) return "none";
  if (!automatic || !offer.canUpdate) return "notify";
  return activeRuns > 0 ? "wait" : "start";
}

export interface ActiveRuns {
  readonly total: number;
  readonly byInstance: Readonly<Record<string, number>>;
}

type RunThread = Pick<
  OrchestrationV2ThreadShell,
  "status" | "activityRunStatus" | "providerInstanceId"
>;

const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** Counts threads whose run has not finished, which an update must not interrupt. */
export function countActiveRuns(threads: ReadonlyArray<RunThread>): ActiveRuns {
  const byInstance: Record<string, number> = {};
  let total = 0;
  for (const thread of threads) {
    if (!LIVE_STATUSES.has(thread.status) && (thread.activityRunStatus ?? null) === null) continue;
    total += 1;
    byInstance[thread.providerInstanceId] = (byInstance[thread.providerInstanceId] ?? 0) + 1;
  }
  return { total, byInstance };
}

export type VersionStatus = "current" | "behind" | "unknown";

/** A line under an item's row: progress in muted text, a problem in warning text. */
export interface UpdateNote {
  readonly text: string;
  readonly tone: "progress" | "problem";
}

/** The engine or one provider instance, as the Updates page lists it. */
export interface UpdateItem {
  readonly key: string;
  readonly kind: "engine" | "provider";
  readonly name: string;
  readonly driver: string | null;
  readonly installed: string | null;
  /** The provider is not installed on the machine that runs T3. */
  readonly missing: boolean;
  readonly latest: string | null;
  readonly status: VersionStatus;
  readonly offer: UpdateOffer | null;
  /** What installs the update by hand. */
  readonly command: string | null;
  readonly running: boolean;
  readonly note: UpdateNote | null;
  readonly activeRuns: number;
}

export interface UpdateRow extends UpdateItem {
  readonly action: UpdateAction;
}

const isLatestIncompatible = (provider: ServerProvider) =>
  provider.compatibilityAdvisory?.latestVersionStatus === "broken" ||
  provider.compatibilityAdvisory?.latestVersionStatus === "unsupported";

/** Mirrors T3's rule for which providers offer an update: enabled, behind, and a usable latest. */
export function providerOffer(provider: ServerProvider): UpdateOffer | null {
  const advisory = provider.versionAdvisory;
  if (
    !provider.enabled ||
    isLatestIncompatible(provider) ||
    advisory?.status !== "behind_latest" ||
    advisory.latestVersion === null
  ) {
    return null;
  }
  return {
    version: advisory.latestVersion,
    canUpdate: advisory.canUpdate && advisory.updateCommand !== null,
  };
}

export const isProviderUpdateRunning = (provider: Pick<ServerProvider, "updateState">) =>
  provider.updateState?.status === "queued" || provider.updateState?.status === "running";

function providerNote(provider: ServerProvider): UpdateNote | null {
  const state = provider.updateState;
  switch (state?.status) {
    case "queued":
    case "running":
      return { text: state.message ?? "Starting update", tone: "progress" };
    case "succeeded":
      return { text: state.message ?? "Updated.", tone: "progress" };
    case "failed":
      return { text: state.message ?? "The update failed.", tone: "problem" };
    case "unchanged":
      return { text: state.message ?? "The provider still looks outdated.", tone: "problem" };
    default:
      return null;
  }
}

export function providerItem(
  provider: ServerProvider,
  name: string,
  activeRuns: number,
): UpdateItem {
  const advisory = provider.versionAdvisory;
  return {
    key: provider.instanceId,
    kind: "provider",
    name,
    driver: provider.driver,
    installed: advisory?.currentVersion ?? provider.version ?? null,
    missing: !provider.installed,
    latest: advisory?.latestVersion ?? null,
    status:
      advisory === undefined || isLatestIncompatible(provider)
        ? "unknown"
        : statusOf(advisory.status),
    offer: providerOffer(provider),
    command: advisory?.updateCommand ?? null,
    running: isProviderUpdateRunning(provider),
    note: providerNote(provider),
    activeRuns,
  };
}

function statusOf(status: "unknown" | "current" | "behind_latest"): VersionStatus {
  return status === "behind_latest" ? "behind" : status;
}

/** Providers before the engine, because the engine restarts and would cut a provider update short. */
export function updateEverythingQueue(rows: ReadonlyArray<UpdateRow>): ReadonlyArray<UpdateRow> {
  return rows
    .filter((row) => row.offer?.canUpdate === true && !row.running)
    .toSorted((left, right) => Number(left.kind === "engine") - Number(right.kind === "engine"));
}

/** The offered items whose release has not been announced yet. */
export function unannounced(
  rows: ReadonlyArray<UpdateRow>,
  announced: Readonly<Record<string, string>>,
): ReadonlyArray<UpdateRow> {
  return rows.filter(
    (row) =>
      row.action === "notify" && row.offer !== null && announced[row.key] !== row.offer.version,
  );
}

export interface UpdateResult {
  readonly name: string;
  readonly version: string | null;
  /** The reason it failed, or null when it updated. */
  readonly failure: string | null;
}

export interface UpdateToastText {
  readonly tone: "info" | "success" | "error";
  readonly title: string;
  readonly description: string | null;
}

const joinNames = (names: ReadonlyArray<string>) =>
  names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;

/** One toast for a batch of updates, which names what updated and why the rest did not. */
export function summarizeResults(results: ReadonlyArray<UpdateResult>): UpdateToastText | null {
  if (results.length === 0) return null;
  const updated = results.filter((result) => result.failure === null);
  const failed = results.filter((result) => result.failure !== null);
  const failures = failed.map((result) => `${result.name}: ${result.failure}`).join("\n");
  if (failed.length === 0) {
    const [only] = updated;
    return {
      tone: "success",
      title:
        updated.length === 1 && only?.version != null
          ? `${only.name} updated to ${only.version}`
          : `Updated ${joinNames(updated.map((result) => result.name))}`,
      description: null,
    };
  }
  return {
    tone: "error",
    title:
      updated.length === 0
        ? `${joinNames(failed.map((result) => result.name))} could not update`
        : `${failed.length} of ${results.length} updates failed`,
    description: failures,
  };
}
