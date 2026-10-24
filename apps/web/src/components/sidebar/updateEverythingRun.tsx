import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";

import { APP_VERSION } from "~/branding";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { serverEnvironment } from "~/state/server";
import { resolveVersionMismatch } from "~/versionSkew";
import {
  collectServerUpdateTargets,
  collectUpdateOptions,
  type UpdateItemKey,
} from "./updateEverything.logic";
import { updateOptionsSnapshotAtom } from "./updateEverythingOptions";
import {
  isHostedMaintenanceReady,
  waitForHostedMaintenance as waitForHostedMaintenanceInRegistry,
  waitForHostedProviderWork as waitForHostedProviderWorkInRegistry,
} from "./updateEverythingMaintenance";
import {
  createUpdatePlanClaimOwner,
  createUpdatePlanItemResolver,
  retryExecutionPlan,
} from "./updateEverythingExecution";
import { downloadUpdateForPlan, observeDesktopInstallFailure } from "./updateEverythingDesktop";
import {
  runUpdatePlan,
  type UpdateExecutionPlan,
  type UpdatePlanItem,
  type UpdatePlanPorts,
  type UpdatePlanStore,
} from "./updateEverythingPlan";
import { updatePlanStore } from "./updateEverythingPlanStore";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  closeFinishedUpdateRun,
  getUpdateEverythingToastView,
  type UpdateEverythingResult,
  type UpdateEverythingRun,
  type UpdateRunMachine,
} from "./updateEverything.logic";

const updateEverythingRunAtom = Atom.make<UpdateEverythingRun | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("update-everything-run"),
);

export function useUpdateEverythingRun(): UpdateEverythingRun | null {
  return useAtomValue(updateEverythingRunAtom);
}

function setUpdateEverythingRun(
  update: (run: UpdateEverythingRun | null) => UpdateEverythingRun | null,
): void {
  appAtomRegistry.update(updateEverythingRunAtom, update);
}

function updateRunMachines(update: (machine: UpdateRunMachine) => UpdateRunMachine): void {
  setUpdateEverythingRun(
    (run) => run && closeFinishedUpdateRun({ ...run, machines: run.machines.map(update) }),
  );
}

function settleUpdateRunMachine(environmentId: EnvironmentId, failure: string | null): void {
  updateRunMachines((machine) =>
    machine.environmentId === environmentId
      ? {
          ...machine,
          result: failure === null ? "done" : "failed",
          failure,
        }
      : machine,
  );
}

export function dismissSettledUpdateRunMachines(): void {
  setUpdateEverythingRun(
    (run) =>
      run &&
      closeFinishedUpdateRun({
        ...run,
        machines: run.machines.filter((machine) => machine.result === null),
      }),
  );
}

let decideRestart: ((restart: boolean) => void) | null = null;

function waitForUpdateRestart(delayMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const decide = (restart: boolean) => {
      clearTimeout(timer);
      decideRestart = null;
      resolve(restart);
    };
    const timer = setTimeout(() => decide(true), delayMs);
    decideRestart = decide;
    setUpdateEverythingRun(
      (run) => run && { ...run, phase: "countdown", restartAt: Date.now() + delayMs },
    );
  });
}

export function postponeUpdateRestart(): void {
  decideRestart?.(false);
  if (displayedPlanId !== null) void pauseSavedUpdatePlan("later");
}

const SAVED_RESULT_KEY = "t3code:update-everything-result:v1";
const SAVED_RESULT_MAX_AGE_MS = 10 * 60 * 1000;
// Covers a background service's 30-minute trial start, like the server update itself.
const HANDOFF_TIMEOUT_MS = 32 * 60 * 1000;

const HandedOffServer = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  targetVersion: Schema.String,
  startedAt: Schema.Number,
});
type HandedOffServer = typeof HandedOffServer.Type;

const SavedResult = Schema.Struct({
  savedAt: Schema.Number,
  localVersion: Schema.NullOr(Schema.String),
  updatedServers: Schema.Number,
  updatedProviders: Schema.Number,
  failures: Schema.Array(Schema.String),
  handedOff: Schema.optional(Schema.Array(HandedOffServer)),
});
const decodeSavedResult = Schema.decodeUnknownOption(Schema.fromJsonString(SavedResult));

export function saveUpdateEverythingResult(result: UpdateEverythingResult): void {
  const run = appAtomRegistry.get(updateEverythingRunAtom);
  const handedOff = (run?.machines ?? []).flatMap((machine): HandedOffServer[] => {
    if (machine.result !== null) return [];
    const state = appAtomRegistry.get(serverEnvironment.updateStateAtom(machine.environmentId));
    // A desktop-managed server installs its own feed's version, which only its
    // update state knows.
    const targetVersion =
      machine.handedOffVersion ??
      (state.status === "running" ? state.targetVersion : machine.server?.targetVersion);
    if (targetVersion === undefined) return [];
    return [
      {
        environmentId: machine.environmentId,
        label: machine.label,
        targetVersion,
        startedAt: machine.startedAt,
      },
    ];
  });
  try {
    window.localStorage.setItem(
      SAVED_RESULT_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        localVersion: result.localVersion,
        updatedServers: result.updatedServers,
        updatedProviders: result.updatedProviders,
        failures: result.failures,
        handedOff,
      } satisfies typeof SavedResult.Type),
    );
  } catch {}
}

export function clearSavedUpdateEverythingResult(): void {
  try {
    window.localStorage.removeItem(SAVED_RESULT_KEY);
  } catch {}
}

function takeSavedUpdateEverythingResult(): typeof SavedResult.Type | null {
  try {
    const raw = window.localStorage.getItem(SAVED_RESULT_KEY);
    if (raw === null) return null;
    window.localStorage.removeItem(SAVED_RESULT_KEY);
    return Option.getOrNull(
      Option.filter(
        decodeSavedResult(raw),
        (saved) => Date.now() - saved.savedAt < SAVED_RESULT_MAX_AGE_MS,
      ),
    );
  } catch {
    return null;
  }
}

function showUpdateEverythingResult(result: UpdateEverythingResult): void {
  const view = getUpdateEverythingToastView(result, APP_VERSION);
  if (!view) return;
  toastManager.add(
    stackedThreadToast({
      type: view.type,
      title: view.title,
      ...(view.description
        ? { description: <span className="whitespace-pre-line">{view.description}</span> }
        : {}),
    }),
  );
}

function followHandedOffServers(servers: ReadonlyArray<HandedOffServer>): void {
  if (servers.length === 0) return;
  setUpdateEverythingRun(() => ({
    localVersion: null,
    phase: "servers",
    restartAt: null,
    machines: servers.map((server) => ({
      environmentId: server.environmentId,
      label: server.label,
      updatesProviders: false,
      server: null,
      handedOffVersion: server.targetVersion,
      startedAt: server.startedAt,
      result: null,
      failure: null,
    })),
  }));
  let remaining = servers.length;
  let updatedServers = 0;
  const failures: string[] = [];
  for (const server of servers) {
    let settled = false;
    const settle = (failure: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      queueMicrotask(() => unsubscribe());
      settleUpdateRunMachine(server.environmentId, failure);
      if (failure === null) updatedServers += 1;
      else failures.push(`${server.label}: ${failure}`);
      remaining -= 1;
      if (remaining === 0) {
        showUpdateEverythingResult({
          localVersion: null,
          updatedServers,
          updatedProviders: 0,
          failures,
          restarting: [],
        });
      }
    };
    const timer = setTimeout(
      () => settle(`Not back after ${HANDOFF_TIMEOUT_MS / 60_000} minutes`),
      server.startedAt + HANDOFF_TIMEOUT_MS - Date.now(),
    );
    const unsubscribe = appAtomRegistry.subscribe(
      serverEnvironment.configValueAtom(server.environmentId),
      (config) => {
        if (
          config !== null &&
          resolveVersionMismatch(config.environment.serverVersion, server.targetVersion) === null
        ) {
          settle(null);
        }
      },
      { immediate: true },
    );
  }
}

let notifiedNotAppliedVersion: string | null = null;
let ownedNotAppliedVersion: string | null = null;

export function DesktopUpdateLaunchNotice() {
  const notAppliedVersion = useDesktopUpdateState()?.notAppliedVersion ?? null;

  useEffect(() => {
    const saved = takeSavedUpdateEverythingResult();
    if (!saved) return;
    const handedOff = saved.handedOff ?? [];
    showUpdateEverythingResult({ ...saved, restarting: handedOff.map((server) => server.label) });
    followHandedOffServers(handedOff);
  }, []);

  useEffect(() => {
    if (notAppliedVersion === null || notifiedNotAppliedVersion === notAppliedVersion) return;
    void updatePlanStore()
      .then((store) => store.read())
      .then((plan) => {
        if (
          plan?.items.some(
            (item) => item.kind === "app" && item.targetVersion === notAppliedVersion,
          )
        )
          return;
        if (
          ownedNotAppliedVersion === notAppliedVersion ||
          notifiedNotAppliedVersion === notAppliedVersion
        )
          return;
        notifiedNotAppliedVersion = notAppliedVersion;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Update did not apply",
            description: `T3 Code is still on ${APP_VERSION}. Install ${notAppliedVersion} again from the update button.`,
          }),
        );
      })
      .catch(() => {});
  }, [notAppliedVersion]);

  return null;
}

const rendererClaimId = randomUUID();
const claimOwner = createUpdatePlanClaimOwner(
  rendererClaimId,
  () => {
    void wakeUpdatePlan();
  },
  globalThis.navigator?.locks,
);
let desktopNotAppliedVersion: string | null = null;
let coordinatorRunning = false;
let coordinatorAgain = false;
let recoveryPlanId: string | null = null;
const executingItems = new Set<string>();
let displayedPlanId: string | null = null;
let storageStopped = false;
let displayGeneration = 0;

function planReady(plan: UpdateExecutionPlan): boolean {
  if (storageStopped) return false;
  const snapshot = appAtomRegistry.get(updateOptionsSnapshotAtom);
  if (!snapshot.ready || snapshot.primaryEnvironmentId !== plan.primaryEnvironmentId) return false;
  if (plan.primaryEnvironmentId === null) return true;
  return snapshot.machines.some(
    (machine) =>
      machine.environmentId === plan.primaryEnvironmentId &&
      machine.connected &&
      machine.sessionReady &&
      machine.serverConfig?.environment.environmentId === plan.primaryEnvironmentId,
  );
}

const planItemResolver = createUpdatePlanItemResolver(
  () => appAtomRegistry.get(updateOptionsSnapshotAtom),
  () => {
    void wakeUpdatePlan();
  },
);
const resolvePlanItem = planItemResolver.resolve;

function waitForHostedMaintenance(): Promise<void> {
  return waitForHostedMaintenanceInRegistry(appAtomRegistry, updateOptionsSnapshotAtom);
}

export function waitForHostedProviderWork(): Promise<void> {
  return waitForHostedProviderWorkInRegistry(appAtomRegistry, updateOptionsSnapshotAtom);
}

const planPorts: UpdatePlanPorts = {
  claimId: rendererClaimId,
  ...(claimOwner.isAlive ? { isClaimOwnerAlive: claimOwner.isAlive } : {}),
  appVersion: APP_VERSION,
  now: Date.now,
  ready: planReady,
  notAppliedVersion: () => desktopNotAppliedVersion,
  resolve: resolvePlanItem,
  download: (item) =>
    window.desktopBridge
      ? downloadUpdateForPlan(window.desktopBridge, item.targetVersion)
      : Promise.resolve(false),
  waitForMaintenance: waitForHostedMaintenance,
  maintenanceReady: () => isHostedMaintenanceReady(appAtomRegistry.get(updateOptionsSnapshotAtom)),
  countdown: () => waitForUpdateRestart(5_000),
  install: async (item) => {
    if (!window.desktopBridge) return false;
    if (
      item.autoResume === false &&
      window.desktopBridge.supportsUpdateThreadContinuationControl !== true
    )
      return false;
    try {
      const result = await window.desktopBridge.installUpdate(item.targetVersion, item.autoResume);
      return (
        result.accepted &&
        !(result.state.status === "error" && result.state.errorContext === "install")
      );
    } catch {
      return false;
    }
  },
  execute: async (item) => {
    executingItems.add(item.key);
    try {
      const latest = resolvePlanItem(item, false);
      if (latest.status !== "ready") return latest;
      if (item.kind === "server") {
        const machine = appAtomRegistry
          .get(updateOptionsSnapshotAtom)
          .machines.find((machine) => machine.environmentId === item.environmentId)!;
        const target = collectServerUpdateTargets(
          [machine],
          item.targetVersion,
          item.retryRequested === true,
        ).targets[0];
        if (!target) return { status: "skipped", message: "T3 update is no longer available" };
        if (
          item.autoResume === false &&
          machine.serverConfig?.environment.capabilities.threadRestartContinuationControl !== true
        )
          return {
            status: "skipped",
            message: "This version cannot disable thread resume for an update",
          };
        const result = await runAtomCommand(
          appAtomRegistry,
          serverEnvironment.updateServer,
          {
            environmentId: item.environmentId,
            input: {
              targetVersion: item.targetVersion,
              ...(item.autoResume === false
                ? { continueRunningThreads: false }
                : item.continueThreads &&
                    target.threadContinuation &&
                    target.continueThreadsAfterServerUpdate
                  ? { continueRunningThreads: true }
                  : {}),
            },
          },
          { reportFailure: false },
        );
        if (result._tag === "Success") return { status: "done" };
        return {
          status: isAtomCommandInterrupted(result) ? "unknown" : "failed",
          message: String(squashAtomCommandFailure(result)),
        };
      }
      if (!item.driver || !item.instanceId)
        return { status: "skipped", message: "Provider identity is missing" };
      const result = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.updateProvider,
        {
          environmentId: item.environmentId,
          input: {
            provider: item.driver,
            instanceId: item.instanceId,
            ...(item.targetVersion === "latest" ? {} : { targetVersion: item.targetVersion }),
          },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure")
        return {
          status: isAtomCommandInterrupted(result) ? "unknown" : "failed",
          message: String(squashAtomCommandFailure(result)),
        };
      const provider = result.value.providers.find(
        (provider) => provider.driver === item.driver && provider.instanceId === item.instanceId,
      );
      return provider?.updateState?.status === "succeeded"
        ? { status: "done" }
        : {
            status: "failed",
            message: provider?.updateState?.message ?? "Provider update did not finish",
          };
    } finally {
      executingItems.delete(item.key);
    }
  },
};

function showPlan(plan: UpdateExecutionPlan | null): void {
  ownedNotAppliedVersion = plan?.items.find((item) => item.kind === "app")?.targetVersion ?? null;
  if (!plan) {
    planItemResolver.dispose();
    if (displayedPlanId !== null) setUpdateEverythingRun(() => null);
    displayedPlanId = null;
    return;
  }
  displayedPlanId = plan.id;
  const groups = new Map<EnvironmentId, UpdatePlanItem[]>();
  for (const item of plan.items) {
    if (item.kind === "app") continue;
    const items = groups.get(item.environmentId) ?? [];
    items.push(item);
    groups.set(item.environmentId, items);
  }
  const app = plan.items.find((item) => item.kind === "app");
  setUpdateEverythingRun((current) => {
    const countingDown =
      current?.phase === "countdown" &&
      plan.phase === "local" &&
      current.restartAt !== null &&
      current.restartAt > Date.now();
    return {
      localVersion: app && app.status !== "skipped" ? app.targetVersion : null,
      phase:
        plan.phase === "awaiting-local" ? "installing" : countingDown ? "countdown" : plan.phase,
      pausedReason: plan.pausedReason,
      restartAt: countingDown ? current.restartAt : null,
      machines: [...groups.entries()].map(([environmentId, items]) => {
        const server = items.find((item) => item.kind === "server");
        const failures = items.filter(
          (item) =>
            item.status === "failed" || item.status === "unknown" || item.status === "skipped",
        );
        return {
          environmentId,
          label: items[0]!.label,
          updatesProviders: items.some((item) => item.kind === "provider"),
          server: server
            ? {
                environmentId,
                serverLabel: server.label,
                targetVersion: server.targetVersion,
                selfUpdate: null,
              }
            : null,
          handedOffVersion: null,
          startedAt: plan.createdAt,
          result: items.some((item) => item.status === "pending" || item.status === "claimed")
            ? null
            : failures.length > 0
              ? "failed"
              : "done",
          failure: failures.map((item) => item.message ?? "Update skipped").join("\n") || null,
        };
      }),
    };
  });
}

function storageFailure(error: unknown): void {
  storageStopped = true;
  setUpdateEverythingRun((run) => ({
    localVersion: run?.localVersion ?? null,
    machines: run?.machines ?? [],
    phase: "paused",
    pausedReason: "storage",
    restartAt: null,
  }));
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Update plan could not be saved",
      description:
        error instanceof Error
          ? error.message
          : "Storage is unavailable. No new updates will start.",
    }),
  );
}

async function readPlanForDisplay(store: UpdatePlanStore): Promise<UpdateExecutionPlan | null> {
  const generation = ++displayGeneration;
  const plan = await store.read();
  if (generation === displayGeneration && !storageStopped) showPlan(plan);
  return plan;
}

async function wakeUpdatePlan(): Promise<void> {
  if (storageStopped) return;
  if (coordinatorRunning) {
    coordinatorAgain = true;
    return;
  }
  coordinatorRunning = true;
  try {
    await claimOwner.ready;
    do {
      coordinatorAgain = false;
      const store = await updatePlanStore();
      const plan = await readPlanForDisplay(store);
      await runUpdatePlan(store, { ...planPorts, recoveringClaims: plan?.id === recoveryPlanId });
      await readPlanForDisplay(store);
    } while (coordinatorAgain);
  } catch (error) {
    storageFailure(error);
  } finally {
    coordinatorRunning = false;
  }
}

export async function startUpdatePlan(
  selection: ReadonlySet<UpdateItemKey>,
  localVersion: string | null,
  npmPublished: boolean,
  autoResume = true,
): Promise<{ status: "started" | "busy" | "empty" }> {
  if (storageStopped) return { status: "empty" };
  const snapshot = appAtomRegistry.get(updateOptionsSnapshotAtom);
  const options = collectUpdateOptions({ ...snapshot, localVersion, npmPublished, autoResume });
  const items = [...new Set(selection)].flatMap((key) => {
    const item = options.operations.get(key);
    return item ? [item] : [];
  });
  if (items.length === 0 || !snapshot.ready) {
    toastManager.add(
      stackedThreadToast({ type: "info", title: "No selected updates can start right now." }),
    );
    return { status: "empty" };
  }
  const plan: UpdateExecutionPlan = {
    schemaVersion: 1,
    id: randomUUID(),
    primaryEnvironmentId: snapshot.primaryEnvironmentId,
    sourceVersion: APP_VERSION,
    createdAt: Date.now(),
    phase: items.some((item) => item.kind === "app") ? "local" : "servers",
    pausedReason: null,
    items,
  };
  try {
    if (!(await (await updatePlanStore()).create(plan))) return { status: "busy" };
  } catch (error) {
    storageFailure(error);
    return { status: "empty" };
  }
  void wakeUpdatePlan();
  return { status: "started" };
}

async function pauseSavedUpdatePlan(
  reason: NonNullable<UpdateExecutionPlan["pausedReason"]>,
): Promise<void> {
  try {
    await (
      await updatePlanStore()
    ).change((plan) =>
      plan && plan.phase !== "complete" && plan.phase !== "paused"
        ? { ...plan, phase: "paused", pausedReason: reason }
        : plan,
    );
  } catch (error) {
    storageFailure(error);
  }
}

export async function retryUpdatePlan(): Promise<void> {
  try {
    const store = await updatePlanStore();
    const initial = await store.read();
    if (!initial) return;
    const isClaimOwnerAlive = claimOwner.isAlive;
    const deadClaims = isClaimOwnerAlive
      ? (
          await Promise.all(
            initial.items
              .filter(
                (item) =>
                  item.kind !== "app" &&
                  item.status === "claimed" &&
                  item.claimId !== rendererClaimId,
              )
              .map(async (item) =>
                (await isClaimOwnerAlive(item.claimId).catch(() => true)) ? null : item,
              ),
          )
        ).filter((item) => item !== null)
      : undefined;
    const retried = await store.change((plan) => {
      if (
        !plan ||
        plan.pausedReason === "expired" ||
        plan.pausedReason === "storage" ||
        !planReady(plan)
      )
        return plan;
      if (plan.items.some((item) => executingItems.has(item.key))) return plan;
      return retryExecutionPlan(
        plan,
        APP_VERSION,
        resolvePlanItem,
        deadClaims ? { plan: initial, rendererClaimId, deadClaims } : undefined,
      );
    });
    recoveryPlanId = retried?.items.some(
      (item) => item.status === "claimed" && item.claimId !== rendererClaimId,
    )
      ? retried.id
      : null;
    void wakeUpdatePlan();
  } catch (error) {
    storageFailure(error);
  }
}

export async function continueWithoutLocalApp(): Promise<void> {
  if (storageStopped) return;
  try {
    await (
      await updatePlanStore()
    ).change((plan) =>
      plan?.phase === "paused" && plan.pausedReason !== "expired" && plan.pausedReason !== "storage"
        ? {
            ...plan,
            phase: "servers",
            sourceVersion: APP_VERSION,
            pausedReason: null,
            items: plan.items.map((item) =>
              item.kind === "app" && item.status !== "done"
                ? { ...item, status: "skipped", message: "App update skipped by choice" }
                : item,
            ),
          }
        : plan,
    );
    void wakeUpdatePlan();
  } catch (error) {
    storageFailure(error);
  }
}

export async function dismissUpdatePlan(): Promise<void> {
  try {
    if (storageStopped) {
      if (executingItems.size > 0) return;
      await (await updatePlanStore()).discard();
      storageStopped = false;
      setUpdateEverythingRun(() => null);
      showPlan(null);
      return;
    }
    await (
      await updatePlanStore()
    ).change((plan) =>
      plan &&
      (plan.phase === "complete" || plan.phase === "paused") &&
      !plan.items.some((item) => executingItems.has(item.key))
        ? null
        : plan,
    );
    storageStopped = false;
    void wakeUpdatePlan();
  } catch (error) {
    storageFailure(error);
  }
}

export function UpdateEverythingCoordinator() {
  const desktop = useDesktopUpdateState();
  useEffect(() => {
    let disposed = false;
    let unsubscribe = () => {};
    const unsubscribeOptions = appAtomRegistry.subscribe(updateOptionsSnapshotAtom, () => {
      if (displayedPlanId !== null || coordinatorRunning) void wakeUpdatePlan();
    });
    void updatePlanStore()
      .then(async (store) => {
        const plan = await store.read();
        if (disposed) return;
        recoveryPlanId = plan?.id ?? null;
        unsubscribe = store.subscribe(() => {
          void readPlanForDisplay(store)
            .then(() => {
              if (disposed || storageStopped) return;
              void wakeUpdatePlan();
            })
            .catch(storageFailure);
        });
        void wakeUpdatePlan();
      })
      .catch(storageFailure);
    const focus = () => {
      void wakeUpdatePlan();
    };
    window.addEventListener("focus", focus);
    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeOptions();
      window.removeEventListener("focus", focus);
    };
  }, []);
  useEffect(() => {
    desktopNotAppliedVersion = desktop?.notAppliedVersion ?? null;
    if (desktop?.errorContext === "install" && desktop.message) {
      void updatePlanStore()
        .then((store) => store.change((plan) => observeDesktopInstallFailure(plan, desktop)))
        .then(() => wakeUpdatePlan())
        .catch(storageFailure);
    } else if (displayedPlanId !== null || coordinatorRunning) void wakeUpdatePlan();
  }, [desktop]);
  return null;
}
