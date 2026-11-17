import {
  BOAT_CLOUD_START_STEPS,
  type BoatCloudAcquireInput,
  type BoatCloudRunSetupInput,
  type BoatCloudSession,
  type BoatCloudSetup,
  type BoatCloudStepProgress,
  type BoxdCloudConnectInput,
  BoxdCloudError,
  BoxdCloudMachineState,
  type BoxdCloudStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { latestCliRelease } from "@t3tools/shared/boatCloudStart";
import { type BoxdApi, BoxdApiError, makeBoxdApi } from "@t3tools/shared/boxdCloudApi";
import {
  MACHINE_LABEL_FILTER,
  boxdMachineLabelOf,
  boxdMachineStateOf,
  buildSnapshot,
  isSpare,
  makeSpareKeeper,
  parseBoxdRepository,
  snapshotToBuild,
  startMachine,
  startingSnapshot,
} from "@t3tools/shared/boxdCloudStart";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";

const API_KEY_SECRET = "boxd-cloud-api-key";
const START_LINGER = Duration.minutes(2);

const StoredMachine = Schema.Struct({
  vmId: Schema.String,
  environmentId: Schema.NullOr(EnvironmentId),
  httpBaseUrl: Schema.NullOr(Schema.String),
  state: BoxdCloudMachineState,
  repositories: Schema.Array(Schema.String),
});
type StoredMachine = typeof StoredMachine.Type;

const StoredState = Schema.Struct({
  account: Schema.NullOr(Schema.String),
  machines: Schema.Array(StoredMachine),
  /** Git remotes the snapshot checks out, from the client that last ran setup. */
  snapshotRepositories: Schema.Array(Schema.String),
});
type StoredState = typeof StoredState.Type;
const decodeStoredState = Schema.decodeUnknownOption(Schema.fromJsonString(StoredState));
const encodeStoredState = Schema.encodeSync(Schema.fromJsonString(StoredState));

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const isBoxdApiError = Schema.is(BoxdApiError);
/** boxd errors carry fixed or status-built messages; any other failure's text stays in `cause`. */
const describe = (error: unknown) => {
  if (!isBoxdApiError(error)) return null;
  if (error.code === "unauthenticated") return "boxd rejected the API key.";
  if (error.code === "permission_denied") return "The boxd API key is missing access.";
  return error.message;
};

const cloudError = (message: string) => (cause: unknown) =>
  new BoxdCloudError({ message: `${message} ${describe(cause) ?? ""}`.trim(), cause });

const pendingSteps = (): Array<BoatCloudStepProgress> =>
  BOAT_CLOUD_START_STEPS.map((step) => ({ step, state: "pending", detail: null }));

export class BoxdCloudService extends Context.Service<
  BoxdCloudService,
  {
    readonly subscribe: Stream.Stream<BoxdCloudStatus>;
    readonly connect: (
      input: BoxdCloudConnectInput,
    ) => Effect.Effect<BoxdCloudStatus, BoxdCloudError>;
    readonly disconnect: Effect.Effect<BoxdCloudStatus, BoxdCloudError>;
    readonly runSetup: (
      input: BoatCloudRunSetupInput,
    ) => Effect.Effect<BoxdCloudStatus, BoxdCloudError>;
    readonly acquire: (
      input: BoatCloudAcquireInput,
    ) => Effect.Effect<BoatCloudSession, BoxdCloudError>;
  }
>()("t3/boxdCloud/BoxdCloudService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const statePath = path.join(config.stateDir, "boxd-cloud", "state.json");

  const readKey = secrets.get(API_KEY_SECRET).pipe(
    Effect.map(Option.map((bytes) => textDecoder.decode(bytes))),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const stored = yield* fs.readFileString(statePath).pipe(
    Effect.map((text) => Option.getOrUndefined(decodeStoredState(text))),
    Effect.orElseSucceed(() => undefined),
  );
  let state: StoredState = stored ?? { account: null, machines: [], snapshotRepositories: [] };
  let setup: BoatCloudSetup = { status: "idle", step: null, error: null };
  let snapshotName: string | null = null;
  const starts = new Map<string, Array<BoatCloudStepProgress>>();
  const registryLock = yield* Semaphore.make(1);
  const spares = makeSpareKeeper();
  /** One client per key: it keeps its token, which boxd limits how often it issues. */
  let client: { readonly key: string; readonly api: BoxdApi } | null = null;
  const apiFor = (key: string) => {
    if (client?.key !== key) client = { key, api: makeBoxdApi(http, key) };
    return client.api;
  };

  const statusRef = yield* SubscriptionRef.make<BoxdCloudStatus>({
    connected: false,
    account: null,
    setup,
    snapshotReady: false,
    machines: [],
    starts: [],
  });
  const publish = Effect.gen(function* () {
    const connected = Option.isSome(yield* readKey);
    yield* SubscriptionRef.set(statusRef, {
      connected,
      account: connected ? state.account : null,
      setup:
        setup.status === "idle" && snapshotName !== null ? { ...setup, status: "ready" } : setup,
      snapshotReady: connected && snapshotName !== null,
      machines: connected
        ? state.machines.map((machine) => ({ ...machine, label: boxdMachineLabelOf(machine.vmId) }))
        : [],
      starts: [...starts].map(([requestId, steps]) => ({ requestId, steps })),
    });
  });
  /** Every registry change goes through here, reading the state as it is under the lock. */
  const commit = Effect.fnUntraced(function* (update: (current: StoredState) => StoredState) {
    const next = update(state);
    if (next === state) return;
    state = next;
    yield* writeFileStringAtomically({
      filePath: statePath,
      contents: encodeStoredState(next),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catchCause((cause) =>
        Effect.logWarning("boxd cloud could not save its state", { cause }),
      ),
    );
    yield* publish;
  }, registryLock.withPermits(1));
  const updateMachine = (vmId: string, patch: Partial<StoredMachine>) =>
    commit((current) => ({
      ...current,
      machines: current.machines.some((machine) => machine.vmId === vmId)
        ? current.machines.map((machine) =>
            machine.vmId === vmId ? { ...machine, ...patch } : machine,
          )
        : [
            ...current.machines,
            {
              vmId,
              environmentId: null,
              httpBaseUrl: null,
              state: "running",
              repositories: [],
              ...patch,
            },
          ],
    }));

  const requireApi = Effect.gen(function* () {
    const key = yield* readKey;
    if (Option.isNone(key)) {
      return yield* new BoxdCloudError({ message: "Connect boxd in Settings, Cloud first." });
    }
    return apiFor(key.value);
  });

  const refreshSnapshot = (api: BoxdApi) =>
    api.listSnapshots().pipe(
      Effect.tap((snapshots) =>
        Effect.sync(() => {
          snapshotName = startingSnapshot(snapshots);
        }),
      ),
      Effect.ignore,
    );

  /** Folds boxd's list into the registry; a machine deleted in boxd leaves it. */
  const reconcile = Effect.fn("BoxdCloud.reconcile")(function* (api: BoxdApi) {
    const machines = yield* api.listMachines([MACHINE_LABEL_FILTER]);
    spares.reconcile(machines);
    const byId = new Map(machines.map((machine) => [machine.id, machine]));
    yield* commit((current) => {
      const known = new Set(current.machines.map((machine) => machine.vmId));
      return {
        ...current,
        machines: [
          ...current.machines.flatMap((machine) => {
            const listed = byId.get(machine.vmId);
            return listed ? [{ ...machine, state: boxdMachineStateOf(listed.status) }] : [];
          }),
          // Machines another holder made with the same key are shared. The spare joins once taken.
          ...machines
            .filter((machine) => !known.has(machine.id) && !isSpare(machine))
            .map((machine) => ({
              vmId: machine.id,
              environmentId: null,
              httpBaseUrl: machine.url,
              state: boxdMachineStateOf(machine.status),
              repositories: [],
            })),
        ],
      };
    });
  });

  const keepSpare = (api: BoxdApi) =>
    Effect.suspend(() => (snapshotName === null ? Effect.void : spares.keep(api, snapshotName)));

  const finishSetup = (api: BoxdApi, saved: string | null, error: string | null) =>
    Effect.suspend(() => {
      if (saved !== null) snapshotName = saved;
      setup =
        saved !== null
          ? { status: "idle", step: null, error: null }
          : { status: "failed", step: setup.step, error };
      return saved === null
        ? publish
        : Effect.andThen(publish, keepSpare(api).pipe(Effect.forkDetach, Effect.asVoid));
    });

  /** Setup outlives the request that starts it; the page follows it through the status stream. */
  const startSetup = Effect.fn("BoxdCloud.startSetup")(function* (
    api: BoxdApi,
    knownVersion?: string,
  ) {
    if (setup.status === "running") return;
    setup = { status: "running", step: "create-vm", error: null };
    yield* publish;
    yield* Effect.gen(function* () {
      const version = knownVersion ?? (yield* latestCliRelease(http));
      return yield* buildSnapshot({
        api,
        version,
        repositories: state.snapshotRepositories,
        setStep: (step) =>
          Effect.suspend(() => {
            setup = { status: "running", step, error: null };
            return publish;
          }),
      });
    }).pipe(
      Effect.matchCauseEffect({
        onSuccess: (saved) => finishSetup(api, saved, null),
        onFailure: (cause) =>
          Effect.logWarning("boxd cloud setup failed", { cause }).pipe(
            Effect.andThen(
              finishSetup(
                api,
                null,
                Option.match(Cause.findErrorOption(cause), {
                  onNone: () => "Setup stopped.",
                  onSome: (error) => describe(error) ?? "Setup failed.",
                }),
              ),
            ),
          ),
      }),
      Effect.forkDetach,
    );
  });

  const runSetup = Effect.fn("BoxdCloud.runSetup")(function* (input: BoatCloudRunSetupInput) {
    const api = yield* requireApi;
    const repositories = input.repositories;
    if (repositories !== undefined) {
      yield* commit((current) => ({ ...current, snapshotRepositories: repositories }));
    }
    yield* startSetup(api);
    return yield* SubscriptionRef.get(statusRef);
  });

  /** Saves the latest t3 build once boxd has no snapshot of it; machines use the old one meanwhile. */
  const renewSnapshot = Effect.fn("BoxdCloud.renewSnapshot")(
    function* (api: BoxdApi) {
      yield* refreshSnapshot(api);
      if (snapshotName === null || setup.status !== "idle") return;
      const version = yield* snapshotToBuild(api, http);
      if (version === null) return;
      yield* Effect.logInfo("boxd cloud saves a snapshot of the latest t3 build", { version });
      yield* startSetup(api, version);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("boxd cloud could not check the snapshot's t3 build", { cause }),
    ),
  );

  const knownWorkspaceRoots = (vmId: string) =>
    (state.machines.find((machine) => machine.vmId === vmId)?.repositories ?? []).flatMap((key) => {
      const parsed = parseBoxdRepository(`https://${key}`);
      return parsed ? [parsed.workspaceRoot] : [];
    });

  const acquire = Effect.fn("BoxdCloud.acquire")(function* (input: BoatCloudAcquireInput) {
    const api = yield* requireApi;
    const repository = parseBoxdRepository(input.repositoryUrl);
    if (repository === null) {
      return yield* new BoxdCloudError({
        message: "boxd cloud needs a project with a git remote it can clone.",
      });
    }
    if (snapshotName === null) yield* refreshSnapshot(api);
    const snapshot = snapshotName;
    if (snapshot === null) {
      return yield* new BoxdCloudError({ message: "Finish boxd cloud setup in Settings, Cloud." });
    }
    starts.set(input.requestId, pendingSteps());
    const finish = Effect.suspend(() => {
      starts.delete(input.requestId);
      return publish;
    });
    const report = (
      step: BoatCloudStepProgress["step"],
      stepState: BoatCloudStepProgress["state"],
      detail: string | null,
    ) =>
      Effect.suspend(() => {
        const steps = starts.get(input.requestId);
        if (!steps) return Effect.void;
        starts.set(
          input.requestId,
          steps.map((entry) => (entry.step === step ? { step, state: stepState, detail } : entry)),
        );
        return publish;
      });
    const readySpare = yield* spares.take(snapshot);
    const started = yield* startMachine({
      api,
      repository,
      baseBranch: input.baseBranch ?? null,
      snapshot,
      readySpare,
      knownWorkspaceRoots,
      paired: input.paired ?? [],
      report,
    }).pipe(
      Effect.onError(() => finish),
      // Clients title this failure "Could not start on boxd cloud", so the message is just the cause.
      Effect.mapError(
        (cause) =>
          new BoxdCloudError({
            message: describe(cause) ?? "Something went wrong on boxd.",
            cause,
          }),
      ),
    );
    yield* updateMachine(started.vmId, {
      environmentId: started.environmentId,
      httpBaseUrl: started.httpBaseUrl,
      state: "running",
    });
    // The start may have taken the spare, so the next one is readied while this one checks out.
    yield* keepSpare(api).pipe(Effect.forkDetach);
    yield* started.checkout.pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const repositories =
            state.machines.find((machine) => machine.vmId === started.vmId)?.repositories ?? [];
          return repositories.includes(repository.key)
            ? Effect.void
            : updateMachine(started.vmId, { repositories: [...repositories, repository.key] });
        }),
      ),
      Effect.ignore,
      // The last step stays listed long enough for the client to read it.
      Effect.andThen(finish.pipe(Effect.delay(START_LINGER))),
      Effect.forkDetach,
    );
    return {
      sandboxId: started.vmId,
      environmentId: started.environmentId,
      httpBaseUrl: started.httpBaseUrl,
      pairingCode: started.pairingCode,
      workspaceRoot: started.workspaceRoot,
      worktree: started.worktree,
    } satisfies BoatCloudSession;
  });

  const connect = Effect.fn("BoxdCloud.connect")(function* (input: BoxdCloudConnectInput) {
    const api = apiFor(input.apiKey);
    const account = yield* api
      .whoami()
      .pipe(Effect.mapError(cloudError("Could not connect boxd.")));
    yield* secrets
      .set(API_KEY_SECRET, textEncoder.encode(input.apiKey))
      .pipe(Effect.mapError(cloudError("Could not save the boxd API key.")));
    yield* refreshSnapshot(api);
    yield* renewSnapshot(api).pipe(Effect.forkDetach);
    // Another account's machines mean nothing to this key.
    yield* commit((current) =>
      current.account === account ? current : { ...current, account, machines: [] },
    );
    yield* publish;
    return yield* SubscriptionRef.get(statusRef);
  });

  const disconnect = Effect.gen(function* () {
    yield* secrets
      .remove(API_KEY_SECRET)
      .pipe(Effect.mapError(cloudError("Could not remove the boxd API key.")));
    client = null;
    snapshotName = null;
    setup = { status: "idle", step: null, error: null };
    yield* publish;
    return yield* SubscriptionRef.get(statusRef);
  }).pipe(Effect.withSpan("BoxdCloud.disconnect"));

  const initialKey = yield* readKey;
  if (Option.isSome(initialKey)) yield* refreshSnapshot(apiFor(initialKey.value));
  yield* publish;

  // Opening the page refreshes from boxd in the background; the stream starts on the last known state.
  const refreshInBackground = Effect.gen(function* () {
    const key = yield* readKey;
    if (Option.isNone(key)) return;
    const api = apiFor(key.value);
    yield* renewSnapshot(api);
    yield* reconcile(api).pipe(Effect.ignore);
    yield* publish;
    // A client is here, so a start may follow.
    yield* keepSpare(api);
  }).pipe(Effect.forkDetach);

  return BoxdCloudService.of({
    subscribe: Stream.unwrap(
      refreshInBackground.pipe(Effect.as(SubscriptionRef.changes(statusRef))),
    ),
    connect,
    disconnect,
    runSetup,
    acquire,
  });
});

export const layer = Layer.effect(BoxdCloudService, make);
