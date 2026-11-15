import {
  BOAT_CLOUD_SNAPSHOT_NAME,
  BOAT_CLOUD_START_STEPS,
  type BoatCloudAcquireInput,
  type BoatCloudConfigureEnvironmentInput,
  type BoatCloudConnectInput,
  type BoatCloudEnvironment,
  BoatCloudError,
  BoatCloudMachineState,
  type BoatCloudSession,
  type BoatCloudSetup,
  type BoatCloudStepProgress,
  type BoatCloudStatus,
  type BoatCloudWakeInput,
  EnvironmentId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import {
  type BoatApi,
  BoatApiError,
  cloudEnvironments,
  makeBoatApi,
} from "@t3tools/shared/boatCloudApi";
import {
  buildSnapshot,
  exec,
  findSandboxByHttpBaseUrl,
  latestCliRelease,
  snapshotIsOutdated,
  startMachine,
  vmFailure,
  waitRunning,
  wakeMachine,
} from "@t3tools/shared/boatCloudStart";
import {
  IDLE_TTL_SECONDS,
  MACHINE_LABEL_FILTER,
  MACHINE_LABELS,
  VM_BACKUP_ARCHIVE,
  VM_SKILLS_ARCHIVE,
  backupScript,
  extractSkillsScript,
  idleScript,
  idleSecondsOf,
  machineLabelOf,
  machineStateOf,
  parseRepository,
  restoreScript,
} from "@t3tools/shared/boatCloudVm";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";

const API_KEY_SECRET = "boat-cloud-api-key";
const SKILL_DIRECTORIES = [".claude/skills", ".agents/skills", ".codex/skills"];
const IDLE_SWEEP_INTERVAL = Duration.minutes(1);
const FAILED_START_LINGER = Duration.minutes(2);
/**
 * This machine backs a VM up and stops it a minute before the VM's own deadline
 * would stop it without a backup. Idle time counts from the last turn on any of
 * its threads, or from when it was handed out, whichever is later.
 */
const IDLE_STOP_SECONDS = IDLE_TTL_SECONDS - 60;

const StoredMachine = Schema.Struct({
  sandboxId: Schema.String,
  environmentId: Schema.NullOr(EnvironmentId),
  label: Schema.String,
  httpBaseUrl: Schema.NullOr(Schema.String),
  state: BoatCloudMachineState,
  repositories: Schema.Array(Schema.String),
  backedUpAt: Schema.NullOr(Schema.String),
  /** Only the environment that hands out a VM watches it for idleness, so two never race to stop it. */
  acquiredAt: Schema.NullOr(Schema.String),
  environment: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
type StoredMachine = typeof StoredMachine.Type;

const StoredState = Schema.Struct({
  account: Schema.NullOr(Schema.String),
  machines: Schema.Array(StoredMachine),
  /** The Boat environment new VMs start on, by name, as Boat's create and list name it. */
  environment: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The t3 build in the snapshot this machine last saved. */
  snapshot: Schema.NullOr(
    Schema.Struct({ sourceSandboxId: Schema.String, version: Schema.String }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
type StoredState = typeof StoredState.Type;
const decodeStoredState = Schema.decodeUnknownOption(Schema.fromJsonString(StoredState));
const encodeStoredState = Schema.encodeSync(Schema.fromJsonString(StoredState));

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const isBoatApiError = Schema.is(BoatApiError);
/** Boat errors carry fixed or attribute-built messages; any other failure's text stays in `cause`. */
const describe = (error: unknown) => {
  if (!isBoatApiError(error)) return null;
  if (error.status === 401) return "Boat rejected the API key.";
  if (error.status === 403) return "The Boat API key is missing access.";
  return error.message;
};

const cloudError = (message: string) => (cause: unknown) =>
  new BoatCloudError({ message: `${message} ${describe(cause) ?? ""}`.trim(), cause });

const pendingSteps = (): Array<BoatCloudStepProgress> =>
  BOAT_CLOUD_START_STEPS.map((step) => ({ step, state: "pending", detail: null }));

export class BoatCloudService extends Context.Service<
  BoatCloudService,
  {
    readonly subscribe: Stream.Stream<BoatCloudStatus>;
    readonly connect: (
      input: BoatCloudConnectInput,
    ) => Effect.Effect<BoatCloudStatus, BoatCloudError>;
    readonly disconnect: Effect.Effect<BoatCloudStatus, BoatCloudError>;
    readonly runSetup: Effect.Effect<BoatCloudStatus, BoatCloudError>;
    readonly configureEnvironment: (
      input: BoatCloudConfigureEnvironmentInput,
    ) => Effect.Effect<BoatCloudStatus, BoatCloudError>;
    readonly acquire: (
      input: BoatCloudAcquireInput,
    ) => Effect.Effect<BoatCloudSession, BoatCloudError>;
    readonly wake: (input: BoatCloudWakeInput) => Effect.Effect<BoatCloudSession, BoatCloudError>;
  }
>()("t3/boatCloud/BoatCloudService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const homeDirectory = yield* HostProcess.HomeDirectory;

  const directory = path.join(config.stateDir, "boat-cloud");
  const statePath = path.join(directory, "state.json");
  const backupPathOf = (environmentId: string) =>
    path.join(directory, "backups", `${environmentId}.tar.gz`);

  const readKey = secrets.get(API_KEY_SECRET).pipe(
    Effect.map(Option.map((bytes) => textDecoder.decode(bytes))),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const stored = yield* fs.readFileString(statePath).pipe(
    Effect.map((text) => Option.getOrUndefined(decodeStoredState(text))),
    Effect.orElseSucceed(() => undefined),
  );
  let state: StoredState = stored ?? {
    account: null,
    machines: [],
    environment: null,
    snapshot: null,
  };
  let setup: BoatCloudSetup = { status: "idle", step: null, error: null };
  let snapshotReady = false;
  let environments: ReadonlyArray<BoatCloudEnvironment> = [];
  let environmentsError: string | null = null;
  const starts = new Map<string, Array<BoatCloudStepProgress>>();
  const sweepLock = yield* Semaphore.make(1);
  const registryLock = yield* Semaphore.make(1);

  const statusRef = yield* SubscriptionRef.make<BoatCloudStatus>({
    connected: false,
    account: null,
    setup,
    snapshotReady: false,
    machines: [],
    starts: [],
    environment: null,
    environments: [],
    environmentsError: null,
  });
  const publish = Effect.gen(function* () {
    const connected = Option.isSome(yield* readKey);
    yield* SubscriptionRef.set(statusRef, {
      connected,
      account: connected ? state.account : null,
      setup: setup.status === "idle" && snapshotReady ? { ...setup, status: "ready" } : setup,
      snapshotReady: connected && snapshotReady,
      machines: connected
        ? state.machines.map(({ acquiredAt: _acquiredAt, ...machine }) => machine)
        : [],
      starts: [...starts].map(([requestId, steps]) => ({ requestId, steps })),
      environment: connected ? state.environment : null,
      environments: connected ? environments : [],
      environmentsError: connected ? environmentsError : null,
    });
  });
  /**
   * Every registry change goes through here. The update reads the state as it is under the
   * lock, so concurrent starts, wakes and sweeps never write back a stale copy. Untraced: the
   * operation that changes the registry already has the span.
   */
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
        Effect.logWarning("boat cloud could not save its state", { cause }),
      ),
    );
    yield* publish;
  }, registryLock.withPermits(1));
  const updateMachine = (sandboxId: string, patch: Partial<StoredMachine>) =>
    commit((current) => ({
      ...current,
      machines: current.machines.map((machine) =>
        machine.sandboxId === sandboxId ? { ...machine, ...patch } : machine,
      ),
    }));
  const addMachine = (sandboxId: string) =>
    commit((current) =>
      current.machines.some((machine) => machine.sandboxId === sandboxId)
        ? current
        : {
            ...current,
            machines: [
              ...current.machines,
              {
                sandboxId,
                environmentId: null,
                label: machineLabelOf(sandboxId),
                httpBaseUrl: null,
                state: "starting",
                repositories: [],
                backedUpAt: null,
                acquiredAt: null,
                environment: null,
              },
            ],
          },
    );
  const findMachine = (sandboxId: string) =>
    state.machines.find((machine) => machine.sandboxId === sandboxId);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const requireApi = Effect.gen(function* () {
    const key = yield* readKey;
    if (Option.isNone(key)) {
      return yield* new BoatCloudError({ message: "Connect Boat in Settings, Cloud first." });
    }
    return makeBoatApi(http, key.value);
  });

  const refreshSnapshot = (api: BoatApi) =>
    api.getSnapshot(BOAT_CLOUD_SNAPSHOT_NAME).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          snapshotReady = snapshot?.status === "ready";
        }),
      ),
      Effect.orElseSucceed(() => null),
    );

  /**
   * Reads Boat's environments. With none chosen yet, Boat's default becomes the
   * choice, so later VMs stay on it even if the Boat default changes.
   */
  const refreshEnvironments = Effect.fn("BoatCloud.refreshEnvironments")(function* (api: BoatApi) {
    const [listed, profiles] = yield* Effect.all(
      [
        api.listEnvironments().pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              environmentsError = describe(error) ?? "Could not read the Boat environments.";
            }),
          ),
          Effect.option,
        ),
        // Without it the sign-ins are unknown, and every provider stays offered.
        api.listCredentialProfiles().pipe(Effect.option),
      ],
      { concurrency: "unbounded" },
    );
    if (Option.isSome(listed)) {
      environments = cloudEnvironments(listed.value, Option.getOrNull(profiles));
      environmentsError = null;
      const fallback = listed.value.find((environment) => environment.isDefault)?.name ?? null;
      if (fallback !== null) {
        yield* commit((current) =>
          current.environment === null ? { ...current, environment: fallback } : current,
        );
      }
    }
    // The list, and a key that was just saved, live outside the registry, so a commit
    // that changed nothing has not published them.
    yield* publish;
  });

  const transferFailure = (cause: unknown) =>
    isBoatApiError(cause)
      ? cause
      : new BoatApiError({
          status: 0,
          code: "transfer",
          message: "Could not copy files between this machine and the VM.",
          retryable: false,
          cause,
        });

  const uploadFile = Effect.fn("BoatCloud.uploadFile")(function* (
    api: BoatApi,
    sandboxId: string,
    remotePath: string,
    localPath: string,
  ) {
    const signedUrl = yield* api.uploadUrl(sandboxId, remotePath);
    const request = yield* HttpClientRequest.put(signedUrl).pipe(
      HttpClientRequest.bodyFile(localPath, { contentType: "application/octet-stream" }),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.mapError(transferFailure),
    );
    const response = yield* http.execute(request).pipe(Effect.mapError(transferFailure));
    if (response.status < 200 || response.status >= 300) return yield* api.fail(response);
  });

  const downloadFile = Effect.fn("BoatCloud.downloadFile")(function* (
    api: BoatApi,
    sandboxId: string,
    remotePath: string,
    localPath: string,
  ) {
    const signedUrl = yield* api.downloadUrl(sandboxId, remotePath);
    const response = yield* http.get(signedUrl).pipe(Effect.mapError(transferFailure));
    if (response.status < 200 || response.status >= 300) return yield* api.fail(response);
    yield* response.stream.pipe(Stream.run(fs.sink(localPath)), Effect.mapError(transferFailure));
  });

  /** Folds Boat's list into the registry: a VM deleted in Boat stays only while its backup can bring it back. */
  const reconcile = Effect.fn("BoatCloud.reconcile")(function* (api: BoatApi) {
    // A VM added after the list was read is missing from it only because it is new.
    const listedFrom = new Set(state.machines.map((machine) => machine.sandboxId));
    const sandboxes = yield* api.listSandboxes(MACHINE_LABEL_FILTER);
    const byId = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));
    const backedUp = new Set<string>();
    for (const machine of state.machines) {
      if (byId.has(machine.sandboxId) || machine.environmentId === null) continue;
      const hasBackup = yield* fs
        .exists(backupPathOf(machine.environmentId))
        .pipe(Effect.orElseSucceed(() => false));
      if (hasBackup) backedUp.add(machine.sandboxId);
    }
    yield* commit((current) => {
      const machines: Array<StoredMachine> = [];
      for (const machine of current.machines) {
        const sandbox = byId.get(machine.sandboxId);
        if (sandbox) {
          machines.push({
            ...machine,
            state: machineStateOf(sandbox.state),
            environment: sandbox.environment ?? null,
          });
        } else if (!listedFrom.has(machine.sandboxId)) {
          machines.push(machine);
        } else if (backedUp.has(machine.sandboxId)) {
          machines.push({ ...machine, state: "gone" });
        }
      }
      const known = new Set(current.machines.map((machine) => machine.sandboxId));
      // VMs another holder made with the same key are shared, but only swept there.
      for (const sandbox of byId.values()) {
        if (known.has(sandbox.id)) continue;
        machines.push({
          sandboxId: sandbox.id,
          environmentId: null,
          label: machineLabelOf(sandbox.id),
          httpBaseUrl: null,
          state: machineStateOf(sandbox.state),
          repositories: [],
          backedUpAt: null,
          acquiredAt: null,
          environment: sandbox.environment ?? null,
        });
      }
      return { ...current, machines };
    });
    return sandboxes;
  });

  /** Rebuilds a VM Boat deleted from the snapshot plus this machine's last backup of it. */
  const restore = Effect.fn("BoatCloud.restore")(function* (
    api: BoatApi,
    machine: StoredMachine,
    environmentId: EnvironmentId,
  ) {
    const created = yield* api.createSandbox({
      name: "Boat cloud",
      type: "default",
      labels: MACHINE_LABELS,
      from: BOAT_CLOUD_SNAPSHOT_NAME,
      ttlSeconds: IDLE_TTL_SECONDS,
      // The rebuilt VM keeps the environment the deleted one had.
      ...(machine.environment === null ? {} : { environment: machine.environment }),
    });
    yield* addMachine(created.id);
    yield* waitRunning(api, created.id);
    yield* uploadFile(api, created.id, VM_BACKUP_ARCHIVE, backupPathOf(environmentId));
    yield* exec(api, created.id, restoreScript, 600);
    // Same environment on a new VM: the new entry takes over the old one's history.
    yield* commit((current) => ({
      ...current,
      machines: current.machines
        .filter((candidate) => candidate.sandboxId !== machine.sandboxId)
        .map((candidate) =>
          candidate.sandboxId === created.id
            ? { ...candidate, repositories: machine.repositories, backedUpAt: machine.backedUpAt }
            : candidate,
        ),
    }));
    return created.id;
  });

  /** Copies the VM's sessions and workspaces here, so a VM Boat deletes can come back. */
  const backup = Effect.fn("BoatCloud.backup")(function* (
    api: BoatApi,
    sandboxId: string,
    environmentId: EnvironmentId,
  ) {
    const target = backupPathOf(environmentId);
    const partial = `${target}.partial`;
    yield* exec(api, sandboxId, backupScript, 600);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* downloadFile(api, sandboxId, VM_BACKUP_ARCHIVE, partial);
    yield* fs.rename(partial, target);
    yield* updateMachine(sandboxId, { backedUpAt: yield* now });
  });

  const backupAndStop = Effect.fn("BoatCloud.backupAndStop")(function* (
    api: BoatApi,
    machine: StoredMachine,
  ) {
    // A start can hand the VM out again while the sweep probes or backs it up; it stays on then.
    const handedOutAgain = () => {
      const current = findMachine(machine.sandboxId);
      return current?.state !== "running" || current.acquiredAt !== machine.acquiredAt;
    };
    if (handedOutAgain()) return;
    if (machine.environmentId !== null) {
      // The VM's own deadline is a minute away; the backup must not be cut off by it.
      yield* api.extend(machine.sandboxId, IDLE_TTL_SECONDS).pipe(Effect.ignore);
      yield* backup(api, machine.sandboxId, machine.environmentId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("boat cloud could not back up a VM before stopping it", {
            sandboxId: machine.sandboxId,
            cause,
          }),
        ),
      );
    }
    if (handedOutAgain()) return;
    yield* api.stop(machine.sandboxId);
    yield* updateMachine(machine.sandboxId, { state: "stopped" });
    yield* Effect.logInfo("boat cloud stopped an idle VM", { sandboxId: machine.sandboxId });
  });

  const sweepIdle = Effect.gen(function* () {
    const key = yield* readKey;
    if (Option.isNone(key)) return;
    const api = makeBoatApi(http, key.value);
    yield* reconcile(api);
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    for (const machine of state.machines) {
      // A VM this machine never handed out belongs to the holder that did.
      if (machine.state !== "running" || machine.acquiredAt === null) continue;
      const handedOutSecondsAgo = (nowMillis - Date.parse(machine.acquiredAt)) / 1000;
      if (handedOutSecondsAgo < IDLE_STOP_SECONDS) continue;
      const idleSeconds = yield* exec(api, machine.sandboxId, idleScript, 30).pipe(
        Effect.map((output) => idleSecondsOf(output, handedOutSecondsAgo)),
        // A VM that cannot answer is not provably idle.
        Effect.orElseSucceed(() => null),
      );
      if (idleSeconds === null || idleSeconds < IDLE_STOP_SECONDS) continue;
      yield* backupAndStop(api, machine);
    }
  }).pipe(
    sweepLock.withPermits(1),
    Effect.catchCause((cause) => Effect.logWarning("boat cloud idle sweep failed", { cause })),
  );

  const copySkills = Effect.fn("BoatCloud.copySkills")(function* (api: BoatApi, sandboxId: string) {
    const present: Array<string> = [];
    for (const directoryName of SKILL_DIRECTORIES) {
      if (yield* fs.exists(path.join(homeDirectory, directoryName))) present.push(directoryName);
    }
    if (present.length === 0) return;
    yield* fs.makeDirectory(directory, { recursive: true });
    const archive = path.join(directory, "skills.tar.gz");
    const packed = yield* runner.run({
      command: "tar",
      // -h copies what symlinked skills point at; the VM cannot reach their targets.
      args: ["-czhf", archive, "--exclude=node_modules", "-C", homeDirectory, ...present],
      timeout: Duration.minutes(2),
    });
    if (packed.code !== 0) {
      return yield* vmFailure("Could not pack this machine's skills.", "skills", packed.stderr);
    }
    yield* uploadFile(api, sandboxId, VM_SKILLS_ARCHIVE, archive);
    yield* fs.remove(archive).pipe(Effect.ignore);
    yield* exec(api, sandboxId, extractSkillsScript, 300);
  }, Effect.mapError(transferFailure));

  const finishSetup = (succeeded: boolean, error: string | null) =>
    Effect.suspend(() => {
      if (succeeded) snapshotReady = true;
      setup = succeeded
        ? { status: "idle", step: null, error: null }
        : { status: "failed", step: setup.step, error };
      return publish;
    });

  /** Setup outlives the request that starts it; the page follows it through the status stream. */
  const startSetup = Effect.fn("BoatCloud.startSetup")(function* (api: BoatApi) {
    if (setup.status === "running") return;
    setup = { status: "running", step: "create-vm", error: null };
    yield* publish;
    yield* latestCliRelease(http).pipe(
      Effect.flatMap((version) =>
        buildSnapshot({
          api,
          version,
          copySkills: (sandboxId) => copySkills(api, sandboxId),
          setStep: (step) =>
            Effect.suspend(() => {
              setup = { status: "running", step, error: null };
              return publish;
            }),
        }),
      ),
      Effect.tap((snapshot) => commit((current) => ({ ...current, snapshot }))),
      Effect.matchCauseEffect({
        onSuccess: () => finishSetup(true, null),
        onFailure: (cause) =>
          Effect.logWarning("boat cloud setup failed", { cause }).pipe(
            Effect.andThen(
              finishSetup(
                false,
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

  const runSetup = Effect.fn("BoatCloud.runSetup")(function* () {
    yield* startSetup(yield* requireApi);
    return yield* SubscriptionRef.get(statusRef);
  });

  /**
   * A snapshot this machine did not save with the latest t3 build is rebuilt with it, which
   * also uploads this machine's skills again. VMs keep starting from the old one until the new one is saved.
   * A failed setup waits for the Rebuild button or a reconnect, so opening the page never loops.
   */
  const renewSnapshot = Effect.fn("BoatCloud.renewSnapshot")(
    function* (api: BoatApi) {
      const snapshot = yield* refreshSnapshot(api);
      if (snapshot === null || setup.status !== "idle") return;
      const version = yield* latestCliRelease(http);
      if (!snapshotIsOutdated(snapshot, state.snapshot, version)) return;
      yield* Effect.logInfo("boat cloud rebuilds a snapshot without the latest t3 build", {
        version,
        saved: state.snapshot,
      });
      yield* startSetup(api);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("boat cloud could not check the snapshot's t3 build", { cause }),
    ),
  );

  /** Each repository a machine is known to have, as its checkout path on the VM. */
  const knownWorkspaceRoots = (sandboxId: string) =>
    (findMachine(sandboxId)?.repositories ?? []).flatMap((key) => {
      const parsed = parseRepository(`https://${key}`);
      return parsed ? [parsed.workspaceRoot] : [];
    });

  const acquire = Effect.fn("BoatCloud.acquire")(function* (input: BoatCloudAcquireInput) {
    const api = yield* requireApi;
    const repository = parseRepository(input.repositoryUrl);
    if (repository === null) {
      return yield* new BoatCloudError({
        message: "Boat cloud needs a project with a git remote it can clone.",
      });
    }
    // Opening the page and connecting refresh it, so a ready snapshot needs no check per start.
    if (!snapshotReady) yield* refreshSnapshot(api);
    if (!snapshotReady) {
      return yield* new BoatCloudError({ message: "Finish Boat cloud setup in Settings, Cloud." });
    }
    starts.set(input.requestId, pendingSteps());
    const finish = Effect.suspend(() => {
      starts.delete(input.requestId);
      return publish;
    });
    // Starts run side by side; only the idle sweep needs the registry to hold still.
    const started = yield* Effect.gen(function* () {
      const sandboxes = yield* reconcile(api).pipe(sweepLock.withPermits(1));
      return yield* startMachine({
        api,
        repository,
        baseBranch: input.baseBranch ?? null,
        environment: state.environment,
        sandboxes,
        knownWorkspaceRoots,
        paired: input.paired ?? [],
        report: (step, stepState, detail) =>
          Effect.suspend(() => {
            const steps = starts.get(input.requestId);
            if (!steps) return Effect.void;
            starts.set(
              input.requestId,
              steps.map((entry) =>
                entry.step === step ? { step, state: stepState, detail } : entry,
              ),
            );
            return publish;
          }),
        onCreated: (sandbox) => addMachine(sandbox.id),
        // Without this the sweep sees a resumed VM's old hand-out and stops it mid-start.
        onReused: (sandboxId) =>
          Effect.flatMap(now, (acquiredAt) => updateMachine(sandboxId, { acquiredAt })),
      });
    }).pipe(
      Effect.onError(() => finish),
      // Clients title this failure "Could not start on Boat cloud", so the message is just the cause.
      Effect.mapError(
        (cause) =>
          new BoatCloudError({
            message: describe(cause) ?? "Something went wrong on Boat.",
            cause,
          }),
      ),
    );
    yield* updateMachine(started.sandboxId, {
      environmentId: started.environmentId,
      httpBaseUrl: started.httpBaseUrl,
      state: "running",
      acquiredAt: yield* now,
    });
    // The client connects while the checkout runs; its repository step tells it how that ended.
    yield* started.checkout.pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const repositories = findMachine(started.sandboxId)?.repositories ?? [];
          return repositories.includes(repository.key)
            ? Effect.void
            : updateMachine(started.sandboxId, {
                repositories: [...repositories, repository.key],
              });
        }),
      ),
      Effect.matchEffect({
        onSuccess: () => finish,
        // The failed step stays listed long enough for the client to read it.
        onFailure: () => finish.pipe(Effect.delay(FAILED_START_LINGER)),
      }),
      Effect.forkDetach,
    );
    return {
      sandboxId: started.sandboxId,
      environmentId: started.environmentId,
      httpBaseUrl: started.httpBaseUrl,
      pairingCode: started.pairingCode,
      workspaceRoot: started.workspaceRoot,
    } satisfies BoatCloudSession;
  });

  const wake = Effect.fn("BoatCloud.wake")(function* (input: BoatCloudWakeInput) {
    const api = yield* requireApi;
    return yield* Effect.gen(function* () {
      yield* reconcile(api);
      const machine = state.machines.find(
        (candidate) => candidate.environmentId === input.environmentId,
      );
      let sandboxId: string;
      if (machine) {
        sandboxId =
          machine.state === "gone"
            ? yield* restore(api, machine, input.environmentId)
            : machine.sandboxId;
      } else {
        const sandbox = input.httpBaseUrl
          ? yield* findSandboxByHttpBaseUrl(api, input.httpBaseUrl)
          : null;
        if (sandbox === null) {
          return yield* vmFailure("This machine does not know that Boat cloud VM.");
        }
        yield* addMachine(sandbox.id);
        sandboxId = sandbox.id;
      }
      const woken = yield* wakeMachine(api, sandboxId, { pair: true });
      yield* updateMachine(sandboxId, {
        environmentId: woken.environmentId,
        httpBaseUrl: woken.httpBaseUrl,
        state: "running",
        acquiredAt: yield* now,
      });
      return {
        sandboxId,
        environmentId: woken.environmentId,
        httpBaseUrl: woken.httpBaseUrl,
        pairingCode: woken.pairingCode,
        workspaceRoot: null,
      } satisfies BoatCloudSession;
    }).pipe(
      sweepLock.withPermits(1),
      Effect.mapError(cloudError("Could not wake the Boat cloud machine.")),
    );
  });

  const configureEnvironment = Effect.fn("BoatCloud.configureEnvironment")(function* (
    input: BoatCloudConfigureEnvironmentInput,
  ) {
    const api = yield* requireApi;
    return yield* Effect.gen(function* () {
      if (input.access) yield* api.updateEnvironment(input.environmentId, input.access);
      yield* refreshEnvironments(api);
      const chosen = environments.find((environment) => environment.id === input.environmentId);
      if (!chosen) return yield* vmFailure("Boat has no such environment.");
      // VMs already running keep theirs; only new ones start on the choice.
      yield* commit((current) => ({ ...current, environment: chosen.name }));
      return yield* SubscriptionRef.get(statusRef);
    }).pipe(Effect.mapError(cloudError("Could not change the Boat environment.")));
  });

  const connect = Effect.fn("BoatCloud.connect")(function* (input: BoatCloudConnectInput) {
    const api = makeBoatApi(http, input.apiKey);
    const account = yield* api.me().pipe(Effect.mapError(cloudError("Could not connect Boat.")));
    yield* secrets
      .set(API_KEY_SECRET, textEncoder.encode(input.apiKey))
      .pipe(Effect.mapError(cloudError("Could not save the Boat API key.")));
    yield* refreshSnapshot(api);
    yield* renewSnapshot(api).pipe(Effect.forkDetach);
    // Another account's environments, VMs and backups mean nothing to this key; a wake
    // must never restore one account's backup onto another's VM.
    yield* commit((current) =>
      current.account === account
        ? current
        : { ...current, account, environment: null, machines: [] },
    );
    yield* refreshEnvironments(api);
    return yield* SubscriptionRef.get(statusRef);
  });

  const disconnect = Effect.gen(function* () {
    yield* secrets
      .remove(API_KEY_SECRET)
      .pipe(Effect.mapError(cloudError("Could not remove the Boat API key.")));
    snapshotReady = false;
    setup = { status: "idle", step: null, error: null };
    // The account stays recorded, so reconnecting it keeps its VMs and backups.
    yield* publish;
    return yield* SubscriptionRef.get(statusRef);
  }).pipe(Effect.withSpan("BoatCloud.disconnect"));

  const initialKey = yield* readKey;
  if (Option.isSome(initialKey)) {
    const api = makeBoatApi(http, initialKey.value);
    yield* Effect.all([refreshSnapshot(api), refreshEnvironments(api)], { concurrency: 2 });
  }
  yield* publish;
  yield* forkParked(
    sweepIdle.pipe(
      Effect.delay(IDLE_SWEEP_INTERVAL),
      Effect.repeat(Schedule.spaced(IDLE_SWEEP_INTERVAL)),
    ),
  );

  // Opening the page refreshes from Boat in the background; the stream starts on the last known state.
  const refreshInBackground = Effect.gen(function* () {
    const key = yield* readKey;
    if (Option.isNone(key)) return;
    const api = makeBoatApi(http, key.value);
    yield* renewSnapshot(api);
    yield* refreshEnvironments(api);
    yield* reconcile(api).pipe(sweepLock.withPermits(1), Effect.ignore);
    yield* publish;
  }).pipe(Effect.forkDetach);

  return BoatCloudService.of({
    subscribe: Stream.unwrap(
      refreshInBackground.pipe(Effect.as(SubscriptionRef.changes(statusRef))),
    ),
    connect,
    disconnect,
    runSetup: runSetup(),
    configureEnvironment,
    acquire,
    wake,
  });
});

export const layer = Layer.effect(BoatCloudService, make).pipe(Layer.provide(ProcessRunner.layer));
