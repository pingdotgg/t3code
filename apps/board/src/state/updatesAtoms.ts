import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { Atom, type AtomRegistry, AsyncResult } from "effect/reactivity";

import { failureText } from "../settings/failureText";
import { pickableInstances } from "../providers/providers";
import { localState } from "./boards";
import { describeEngineUpdate } from "./engineUpdate";
import {
  engineUpdateOfferAtom,
  engineUpdateStateAtom,
  engineVersionAtom,
  updateEngine,
} from "./engineUpdateAtoms";
import { engineEnvironmentIdAtom, environmentSnapshotAtom } from "./projects";
import { engineProvidersAtom, serverEnvironment } from "./server";
import {
  type ActiveRuns,
  countActiveRuns,
  decideUpdate,
  ENGINE_KEY,
  providerItem,
  summarizeResults,
  unannounced,
  type UpdateItem,
  type UpdateResult,
  type UpdateRow,
  type UpdateToastText,
} from "./updates";

export interface UpdatePrefs {
  readonly autoUpdate: { readonly engine: boolean; readonly providers: boolean };
  /** The release each item announced last, by item key. */
  readonly announced: Readonly<Record<string, string>>;
  /** The latest automatic update of each item, by item key. */
  readonly automatic: Readonly<Record<string, { readonly version: string; readonly at: string }>>;
}

/** Null until the saved choices load, so nothing starts or announces on the defaults. */
export const updatePrefsAtom = Atom.writable(
  (get): UpdatePrefs | null => {
    void localState.read().then((state) =>
      get.setSelf({
        autoUpdate: state.autoUpdate,
        announced: state.announcedUpdates,
        automatic: state.automaticUpdates,
      }),
    );
    return null;
  },
  (context, next: UpdatePrefs | null) => context.setSelf(next),
).pipe(Atom.keepAlive, Atom.withLabel("update-prefs"));

export function changeUpdatePrefs(
  registry: AtomRegistry.AtomRegistry,
  change: (prefs: UpdatePrefs) => UpdatePrefs,
) {
  const current = registry.get(updatePrefsAtom);
  if (current === null) return Promise.resolve();
  const next = change(current);
  registry.set(updatePrefsAtom, next);
  return localState
    .update((state) => ({
      ...state,
      autoUpdate: next.autoUpdate,
      announcedUpdates: next.announced,
      automaticUpdates: next.automatic,
    }))
    .then(() => undefined);
}

const NO_THREADS: ReadonlyArray<never> = [];

/** Threads with an unfinished run, which an automatic update waits for. Equal counts do not notify. */
export const activeRunsAtom = Atom.make((get): ActiveRuns => {
  const environmentId = get(engineEnvironmentIdAtom);
  const threads =
    environmentId === null
      ? NO_THREADS
      : (get(environmentSnapshotAtom(environmentId))?.threads ?? NO_THREADS);
  return countActiveRuns(threads);
}).pipe(Atom.withLabel("active-runs"));

/** The newest engine release, read only where the Updates page shows it. */
export const engineReleaseAtom = Atom.make((get): string | null => {
  const environmentId = get(engineEnvironmentIdAtom);
  if (environmentId === null) return null;
  const release = AsyncResult.getOrElse(
    get(serverEnvironment.npmRelease({ environmentId, input: { spec: "latest" } })),
    () => null,
  );
  return release?.version ?? null;
}).pipe(Atom.withLabel("engine-release"));

/** Update keys with the release they were started for, so a failed update does not start again. */
export const updateAttemptsAtom = Atom.make<ReadonlyArray<string>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("update-attempts"),
);

/** Provider updates this app has started and not seen finish. */
const providerUpdatesRunningAtom = Atom.make(0).pipe(
  Atom.keepAlive,
  Atom.withLabel("provider-updates-running"),
);

const attemptKey = (item: Pick<UpdateItem, "key" | "offer">) =>
  `${item.key}@${item.offer?.version ?? ""}`;

const ENGINE_NAME = "T3 engine";

export const updateItemsAtom = Atom.make((get): ReadonlyArray<UpdateItem> => {
  const runs = get(activeRunsAtom);
  const providers = get(engineProvidersAtom);
  const instances = pickableInstances(providers);
  const version = get(engineVersionAtom);
  const offer = get(engineUpdateOfferAtom);
  const update = get(engineUpdateStateAtom);
  const engine: UpdateItem = {
    key: ENGINE_KEY,
    kind: "engine",
    name: ENGINE_NAME,
    driver: null,
    installed: version,
    missing: false,
    latest: offer?.targetVersion ?? null,
    status: offer === null ? "unknown" : "behind",
    offer: offer === null ? null : { version: offer.targetVersion, canUpdate: true },
    command: null,
    running: update.status === "running",
    note: describeEngineUpdate(update),
    activeRuns: runs.total,
  };
  const providerItems = instances.flatMap((instance) => {
    const provider = providers.find((entry) => entry.instanceId === instance.instanceId);
    return provider === undefined
      ? []
      : [providerItem(provider, instance.name, runs.byInstance[provider.instanceId] ?? 0)];
  });
  return version === null ? providerItems : [engine, ...providerItems];
}).pipe(Atom.withLabel("update-items"));

/** Each item with what to do about it, given the switches, the active runs, and what already started. */
export const updateRowsAtom = Atom.make((get): ReadonlyArray<UpdateRow> => {
  const prefs = get(updatePrefsAtom);
  const attempts = get(updateAttemptsAtom);
  return get(updateItemsAtom).map((item) => ({
    ...item,
    action:
      prefs === null
        ? "none"
        : decideUpdate({
            offer: item.offer,
            automatic:
              item.kind === "engine" ? prefs.autoUpdate.engine : prefs.autoUpdate.providers,
            busy: item.running || attempts.includes(attemptKey(item)),
            activeRuns: item.activeRuns,
          }),
  }));
}).pipe(Atom.withLabel("update-rows"));

/** Whether an offered update waits on the user, which the sidebar's settings icon flags. */
export const updateNoticeAtom = Atom.make((get) =>
  get(updateRowsAtom).some((row) => row.action === "notify"),
).pipe(Atom.withLabel("update-notice"));

export interface UpdateToast extends UpdateToastText {
  readonly id: number;
  /** Whether a press on the toast opens the Updates page. */
  readonly opensUpdates: boolean;
}

export const updateToastsAtom = Atom.make<ReadonlyArray<UpdateToast>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("update-toasts"),
);

let nextToastId = 1;

export function pushUpdateToast(
  registry: AtomRegistry.AtomRegistry,
  toast: UpdateToastText,
  opensUpdates = false,
) {
  registry.set(updateToastsAtom, [
    ...registry.get(updateToastsAtom),
    { ...toast, id: nextToastId++, opensUpdates },
  ]);
}

export function dismissUpdateToast(registry: AtomRegistry.AtomRegistry, id: number) {
  registry.set(
    updateToastsAtom,
    registry.get(updateToastsAtom).filter((toast) => toast.id !== id),
  );
}

/** Starts B4's engine update, which settles once the engine reconnects and reports its outcome. */
export function runEngineUpdate(registry: AtomRegistry.AtomRegistry) {
  const environmentId = registry.get(engineEnvironmentIdAtom);
  const fromVersion = registry.get(engineVersionAtom);
  const offer = registry.get(engineUpdateOfferAtom);
  if (environmentId === null || fromVersion === null || offer === null) {
    return Promise.resolve(null);
  }
  return runAtomCommand(
    registry,
    updateEngine,
    { environmentId, fromVersion, ...offer },
    { reportFailure: false },
  );
}

async function updateEngineItem(registry: AtomRegistry.AtomRegistry): Promise<UpdateResult> {
  const started = await runEngineUpdate(registry);
  const state = registry.get(engineUpdateStateAtom);
  if (state.status === "finished" && state.outcome.status === "committed") {
    return { name: ENGINE_NAME, version: state.outcome.version, failure: null };
  }
  return {
    name: ENGINE_NAME,
    version: null,
    failure:
      started === null
        ? "The app cannot update this engine."
        : (describeEngineUpdate(state)?.text ?? "The update did not finish."),
  };
}

async function updateProviderItem(
  registry: AtomRegistry.AtomRegistry,
  row: UpdateRow,
): Promise<UpdateResult> {
  registry.set(providerUpdatesRunningAtom, registry.get(providerUpdatesRunningAtom) + 1);
  try {
    return await installProviderUpdate(registry, row);
  } finally {
    registry.set(providerUpdatesRunningAtom, registry.get(providerUpdatesRunningAtom) - 1);
  }
}

async function installProviderUpdate(
  registry: AtomRegistry.AtomRegistry,
  row: UpdateRow,
): Promise<UpdateResult> {
  const environmentId = registry.get(engineEnvironmentIdAtom);
  const provider = registry.get(engineProvidersAtom).find((entry) => entry.instanceId === row.key);
  if (environmentId === null || provider === undefined) {
    return { name: row.name, version: null, failure: "The engine does not list this provider." };
  }
  const result = await runAtomCommand(
    registry,
    serverEnvironment.updateProvider,
    { environmentId, input: { provider: provider.driver, instanceId: provider.instanceId } },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    return { name: row.name, version: null, failure: failureText(result) };
  }
  const updated = result.value.providers.find((entry) => entry.instanceId === row.key);
  return updated?.updateState?.status === "succeeded"
    ? {
        name: row.name,
        version: updated.installedVersion ?? updated.version ?? row.offer?.version ?? null,
        failure: null,
      }
    : {
        name: row.name,
        version: null,
        failure: updated?.updateState?.message ?? "The update did not finish.",
      };
}

/**
 * Runs the updates one after another, since the engine restarts and would cut a provider update
 * short. A single manual success needs no toast, because its row already shows the new version.
 */
export async function runUpdates(
  registry: AtomRegistry.AtomRegistry,
  rows: ReadonlyArray<UpdateRow>,
  automatic = false,
) {
  registry.set(updateAttemptsAtom, [...registry.get(updateAttemptsAtom), ...rows.map(attemptKey)]);
  const results: UpdateResult[] = [];
  for (const row of rows) {
    const result =
      row.kind === "engine"
        ? await updateEngineItem(registry)
        : await updateProviderItem(registry, row);
    results.push(result);
    if (automatic && result.failure === null && result.version !== null) {
      const updated = { version: result.version, at: new Date().toISOString() };
      await changeUpdatePrefs(registry, (prefs) => ({
        ...prefs,
        automatic: { ...prefs.automatic, [row.key]: updated },
      }));
    }
  }
  const summary = summarizeResults(results);
  if (summary === null || (!automatic && results.length === 1 && summary.tone === "success"))
    return;
  pushUpdateToast(
    registry,
    automatic && summary.tone === "success"
      ? { ...summary, description: "Updated automatically between runs." }
      : summary,
    automatic,
  );
}

function announce(registry: AtomRegistry.AtomRegistry) {
  const prefs = registry.get(updatePrefsAtom);
  if (prefs === null) return;
  const fresh = unannounced(registry.get(updateRowsAtom), prefs.announced);
  if (fresh.length === 0) return;
  for (const row of fresh) {
    pushUpdateToast(
      registry,
      {
        tone: "info",
        title: `${row.name} ${row.offer?.version ?? ""} is available`,
        description: "Open Updates to install it.",
      },
      true,
    );
  }
  void changeUpdatePrefs(registry, (current) => ({
    ...current,
    announced: {
      ...current.announced,
      ...Object.fromEntries(fresh.map((row) => [row.key, row.offer?.version ?? ""])),
    },
  }));
}

// Each due item runs on its own, so a run that starts on another instance meanwhile only holds
// its own update. The engine restarts, so it waits until no provider update runs or is due.
function startWaiting(registry: AtomRegistry.AtomRegistry) {
  const attempts = registry.get(updateAttemptsAtom);
  const rows = registry.get(updateRowsAtom);
  const due = rows.filter((row) => row.action === "start" && !attempts.includes(attemptKey(row)));
  const providersBusy =
    registry.get(providerUpdatesRunningAtom) > 0 ||
    rows.some((row) => row.kind === "provider" && (row.running || due.includes(row)));
  for (const row of due) {
    if (row.kind === "engine" && providersBusy) continue;
    void runUpdates(registry, [row], true);
  }
}

/**
 * Mounted by the app: announces an offered update once per release and starts each automatic
 * update once no run is active on its engine or provider instance. It never interrupts a run.
 * The work runs in a microtask because it writes atoms this one reads.
 */
export const updateWatcherAtom = Atom.make((get) => {
  get(updatePrefsAtom);
  get(updateRowsAtom);
  get(providerUpdatesRunningAtom);
  const registry = get.registry;
  queueMicrotask(() => {
    announce(registry);
    startWaiting(registry);
  });
}).pipe(Atom.withLabel("update-watcher"));
