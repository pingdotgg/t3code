import {
  BOAT_CLOUD_SNAPSHOT_NAME,
  type BoatCloudEnvironmentAccess,
  type BoatCloudStatus,
} from "@t3tools/contracts";
import { BoatApiError, cloudEnvironments, makeBoatApi } from "@t3tools/shared/boatCloudApi";
import {
  type ReportStep,
  buildSnapshot,
  exec,
  findSandboxByHttpBaseUrl,
  startMachine,
  wakeMachine,
} from "@t3tools/shared/boatCloudStart";
import {
  MACHINE_LABEL_FILTER,
  VM_T3_PORT,
  machineLabelOf,
  machineStateOf,
  npmInstallServerScript,
  parseRepository,
} from "@t3tools/shared/boatCloudVm";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/http";
import { Atom } from "effect/reactivity";

import * as Runtime from "../../lib/runtime";
import { MobileSecureStorage } from "../../persistence/mobile-secure-storage";
import { appAtomRegistry } from "../../state/atom-registry";

/**
 * The phone as a Boat cloud holder: with the key in its own keychain it starts
 * and wakes VMs without any machine connected. A machine holding the key does
 * more (session backups, an idle sweep), so a connected one is used first.
 */

const API_KEY_STORAGE_KEY = "t3code.boat-cloud.api-key";
/** The Boat environment new VMs start on, by name, as a machine holder keeps it. */
const ENVIRONMENT_STORAGE_KEY = "t3code.boat-cloud.environment";

const DISCONNECTED: BoatCloudStatus = {
  connected: false,
  account: null,
  setup: { status: "idle", step: null, error: null },
  machines: [],
  starts: [],
  environment: null,
  environments: [],
  environmentsError: null,
};

export const phoneBoatCloudAtom = Atom.make<BoatCloudStatus>(DISCONNECTED).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-boat-cloud:phone"),
);

const setStatus = (update: (status: BoatCloudStatus) => BoatCloudStatus) =>
  appAtomRegistry.update(phoneBoatCloudAtom, update);

const notConnected = new BoatApiError({
  status: 0,
  code: "not_connected",
  message: "Connect Boat in Settings, Cloud first.",
  retryable: false,
});

const phoneApi = Effect.gen(function* () {
  const key = yield* MobileSecureStorage.use((storage) => storage.getItem(API_KEY_STORAGE_KEY));
  if (key === null) return yield* notConnected;
  return makeBoatApi(yield* HttpClient.HttpClient, key);
});

const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient | MobileSecureStorage>) =>
  Runtime.runtime.runPromise(effect);

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Boat could not be reached.";

// Bumped once the key is stored or removed, so a refresh that read the old key drops its result.
let keyGeneration = 0;

/** Reads the key, the snapshot and the VMs from Boat. Leaves a setup in progress alone. */
export function refreshPhoneBoatCloud(): Promise<void> {
  const generation = keyGeneration;
  const stale = () => generation !== keyGeneration;
  return run(
    Effect.gen(function* () {
      const api = yield* phoneApi;
      const [account, snapshot, sandboxes, environments, profiles, stored] = yield* Effect.all(
        [
          api.me(),
          api.getSnapshotStatus(BOAT_CLOUD_SNAPSHOT_NAME),
          api.listSandboxes(MACHINE_LABEL_FILTER),
          api.listEnvironments().pipe(Effect.result),
          // Without it the sign-ins are unknown, and every provider stays offered.
          api.listCredentialProfiles().pipe(Effect.option),
          MobileSecureStorage.use((storage) => storage.getItem(ENVIRONMENT_STORAGE_KEY)),
        ],
        { concurrency: "unbounded" },
      );
      if (stale()) return;
      const listed = Result.isSuccess(environments)
        ? cloudEnvironments(environments.success, Option.getOrNull(profiles))
        : [];
      // With none chosen yet, Boat's default becomes the choice, so later VMs stay on it.
      const environment = stored ?? listed.find((candidate) => candidate.isDefault)?.name ?? null;
      if (stored === null && environment !== null) {
        yield* MobileSecureStorage.use((storage) =>
          storage.setItem(ENVIRONMENT_STORAGE_KEY, environment),
        );
        if (stale()) return;
      }
      setStatus((status) => ({
        ...status,
        connected: true,
        account,
        setup:
          status.setup.status === "running"
            ? status.setup
            : snapshot === "ready"
              ? { status: "ready", step: null, error: null }
              : status.setup.status === "failed"
                ? status.setup
                : { status: "idle", step: null, error: null },
        machines: sandboxes.map((sandbox) => ({
          sandboxId: sandbox.id,
          environmentId: null,
          label: machineLabelOf(sandbox.id),
          httpBaseUrl: sandbox.subdomain
            ? `https://${sandbox.subdomain}-${VM_T3_PORT}.on.boat.dev`
            : null,
          state: machineStateOf(sandbox.state),
          repositories: [],
          backedUpAt: null,
          environment: sandbox.environment ?? null,
        })),
        environment,
        environments: listed,
        environmentsError: Result.isFailure(environments) ? environments.failure.message : null,
      }));
    }).pipe(
      Effect.catchTags({
        BoatApiError: (error) =>
          Effect.sync(() => {
            if (error.code === "not_connected" && !stale()) setStatus(() => DISCONNECTED);
          }),
      }),
    ),
  ).catch(() => undefined);
}

let loaded: Promise<void> | null = null;

/** Loads the phone's Boat state once per launch; Settings, Cloud refreshes it on open. */
export function ensurePhoneBoatCloudLoaded(): Promise<void> {
  loaded ??= refreshPhoneBoatCloud();
  return loaded;
}

/** Checks the key with Boat, then keeps it in this phone's keychain. Null on success. */
export async function connectPhoneBoatCloud(apiKey: string): Promise<string | null> {
  try {
    await run(
      Effect.gen(function* () {
        yield* makeBoatApi(yield* HttpClient.HttpClient, apiKey).me();
        yield* MobileSecureStorage.use((storage) => storage.setItem(API_KEY_STORAGE_KEY, apiKey));
      }),
    );
  } catch (error) {
    return errorMessage(error);
  }
  keyGeneration += 1;
  await refreshPhoneBoatCloud();
  return null;
}

export async function disconnectPhoneBoatCloud(): Promise<void> {
  keyGeneration += 1;
  await run(
    MobileSecureStorage.use((storage) =>
      Effect.all([
        storage.removeItem(API_KEY_STORAGE_KEY),
        storage.removeItem(ENVIRONMENT_STORAGE_KEY),
      ]),
    ),
  ).catch(() => undefined);
  setStatus(() => DISCONNECTED);
}

/** Picks the environment for the phone's new VMs, and optionally changes what it passes. Null on success. */
export async function configurePhoneBoatCloudEnvironment(
  environmentId: string,
  access?: BoatCloudEnvironmentAccess,
): Promise<string | null> {
  const chosen = appAtomRegistry
    .get(phoneBoatCloudAtom)
    .environments.find((environment) => environment.id === environmentId);
  if (!chosen) return "Boat has no such environment.";
  try {
    await run(
      Effect.gen(function* () {
        const api = yield* phoneApi;
        if (access) yield* api.updateEnvironment(environmentId, access);
        yield* MobileSecureStorage.use((storage) =>
          storage.setItem(ENVIRONMENT_STORAGE_KEY, chosen.name),
        );
      }),
    );
  } catch (error) {
    return errorMessage(error);
  }
  await refreshPhoneBoatCloud();
  return null;
}

/**
 * Builds the snapshot from the phone. The VM installs T3 Code from npm, since
 * the phone has no server build to upload, and gets no skills.
 */
export async function runPhoneBoatCloudSetup(): Promise<void> {
  if (appAtomRegistry.get(phoneBoatCloudAtom).setup.status === "running") return;
  setStatus((status) => ({ ...status, setup: { status: "running", step: null, error: null } }));
  try {
    await run(
      Effect.gen(function* () {
        const api = yield* phoneApi;
        yield* buildSnapshot({
          api,
          install: (sandboxId) =>
            exec(api, sandboxId, npmInstallServerScript("latest"), 600).pipe(Effect.asVoid),
          setStep: (step) =>
            Effect.sync(() =>
              setStatus((status) => ({
                ...status,
                setup: { status: "running", step, error: null },
              })),
            ),
        });
      }),
    );
    setStatus((status) => ({ ...status, setup: { status: "ready", step: null, error: null } }));
  } catch (error) {
    setStatus((status) => ({
      ...status,
      setup: { status: "failed", step: status.setup.step, error: errorMessage(error) },
    }));
  }
}

/** Gets a VM ready for the repository from the phone, reporting each step as it goes. */
export function startOnPhone(input: {
  readonly repositoryUrl: string;
  readonly baseBranch: string | null;
  readonly report: ReportStep;
}) {
  const repository = parseRepository(input.repositoryUrl);
  if (repository === null) {
    return Promise.reject(new Error("Boat cloud cannot clone this project's remote."));
  }
  return run(
    Effect.gen(function* () {
      const api = yield* phoneApi;
      return yield* startMachine({
        api,
        repository,
        baseBranch: input.baseBranch,
        environment: appAtomRegistry.get(phoneBoatCloudAtom).environment,
        // The phone keeps no record of stopped VMs, so it resumes them only for load.
        knownWorkspaceRoots: () => [],
        report: input.report,
      });
    }),
  ).finally(() => void refreshPhoneBoatCloud());
}

/**
 * Turns the VM behind a paired URL back on. Its identity lives on its disk, so
 * the saved pairing reconnects without a new code. Fails when Boat deleted it.
 */
export function wakeOnPhone(httpBaseUrl: string) {
  return run(
    Effect.gen(function* () {
      const api = yield* phoneApi;
      const sandbox = yield* findSandboxByHttpBaseUrl(api, httpBaseUrl);
      if (sandbox === null) {
        return yield* new BoatApiError({
          status: 0,
          code: "gone",
          message: "Boat deleted this VM, and this phone keeps no copy of it.",
          retryable: false,
        });
      }
      return yield* wakeMachine(api, sandbox.id);
    }),
  );
}
