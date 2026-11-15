import {
  BOAT_CLOUD_SNAPSHOT_NAME,
  type BoatCloudSetupStep,
  type BoatCloudStartStep,
  type BoatCloudStepProgress,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { type BoatApi, BoatApiError, type BoatSandbox } from "./boatCloudApi.ts";
import {
  IDLE_TTL_SECONDS,
  type MachineCandidate,
  MACHINE_LABEL_FILTER,
  MACHINE_LABELS,
  type ParsedRepository,
  SETUP_LABEL_FILTER,
  SETUP_LABELS,
  VM_T3_PORT,
  addProjectAndPairScript,
  checkoutScript,
  ensureServerScript,
  machineLabelOf,
  machineStateOf,
  measureScript,
  parseMeasure,
  pickMachine,
  prepareSnapshotScript,
  subdomainOfHttpBaseUrl,
} from "./boatCloudVm.ts";

/**
 * Getting a Boat cloud VM ready for a thread. Every holder of the Boat key runs
 * these: a server for the clients connected to it, or the phone on its own.
 */

const decodeDescriptor = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ environmentId: EnvironmentId })),
);
const decodePairing = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.String })),
);

export const vmFailure = (message: string, code = "vm") =>
  new BoatApiError({ status: 0, code, message, retryable: false });

export const exec = (api: BoatApi, sandboxId: string, script: string, timeoutSeconds = 120) =>
  api
    .exec(sandboxId, script, timeoutSeconds)
    .pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout ?? "")
          : Effect.fail(
              vmFailure(
                (result.stderr ?? "").trim().split("\n").slice(-3).join(" ") ||
                  `A command on the VM exited with ${result.exitCode}.`,
              ),
            ),
      ),
    );

export const waitRunning = (api: BoatApi, sandboxId: string) =>
  api.getSandbox(sandboxId).pipe(
    Effect.flatMap((sandbox) => {
      if (sandbox === null) return Effect.fail(vmFailure("The VM no longer exists.", "gone"));
      if (machineStateOf(sandbox.state) === "running") return Effect.succeed(sandbox);
      return Effect.fail(vmFailure(`The VM is still ${sandbox.state}.`, "starting"));
    }),
    Effect.retry({
      schedule: Schedule.spaced(Duration.millis(500)),
      times: 600,
      while: (error) => error.code === "starting",
    }),
  );

const ensureServer = (api: BoatApi, sandboxId: string) =>
  exec(api, sandboxId, ensureServerScript, 90).pipe(
    Effect.flatMap((output) =>
      Option.match(decodeDescriptor(output), {
        onNone: () => Effect.fail(vmFailure("T3 Code on the VM did not describe itself.")),
        onSome: (descriptor) => Effect.succeed(descriptor.environmentId),
      }),
    ),
  );

/** Boat routes a hosted port only when it is registered after the server listens on it. */
const hostServer = (api: BoatApi, sandboxId: string) =>
  api.host(sandboxId, VM_T3_PORT).pipe(
    Effect.map((url) => {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    }),
  );

const pair = (api: BoatApi, sandboxId: string, workspaceRoot: string | null) =>
  exec(api, sandboxId, addProjectAndPairScript(workspaceRoot, "Boat cloud")).pipe(
    Effect.flatMap((output) =>
      Option.match(decodePairing(output), {
        onNone: () => Effect.fail(vmFailure("T3 Code on the VM did not issue a pairing code.")),
        onSome: (pairing) => Effect.succeed(pairing.credential),
      }),
    ),
  );

const GIT_AUTH_FAILURE = /could not read Username|Authentication failed|Repository not found/u;

/** Boat clones with the GitHub access set up in its dashboard; without it git only says it cannot log in. */
const cloneFailure = (error: BoatApiError, name: string) =>
  GIT_AUTH_FAILURE.test(error.message)
    ? vmFailure(
        `Boat cannot clone ${name}. Connect GitHub in the Boat dashboard, under Environments.`,
        "clone",
      )
    : error;

export type ReportStep = (
  step: BoatCloudStartStep,
  state: BoatCloudStepProgress["state"],
  detail: string | null,
) => Effect.Effect<void>;

const runStep = <A, E, R>(
  report: ReportStep,
  step: BoatCloudStartStep,
  detail: string | null,
  effect: Effect.Effect<A, E, R>,
) =>
  report(step, "active", detail).pipe(
    Effect.andThen(effect),
    Effect.tapError(() => report(step, "failed", detail)),
    Effect.tap(() => report(step, "done", detail)),
  );

export interface StartedMachine {
  readonly sandboxId: string;
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
  readonly pairingCode: string;
  readonly workspaceRoot: string;
  readonly created: boolean;
}

/**
 * Picks a VM for the repository (a free running one, then a stopped one, then a
 * new one from the snapshot), then starts its server while it clones or
 * refreshes the checkout, and mints a pairing code for the client.
 */
export const startMachine = Effect.fn("BoatCloud.startMachine")(function* (input: {
  readonly api: BoatApi;
  readonly repository: ParsedRepository;
  /** The thread's base branch, which must be on the remote. */
  readonly baseBranch: string | null;
  /** The Boat environment a new VM starts on and a reused one must already run; Boat's default when null. */
  readonly environment: string | null;
  /** Checkouts the holder remembers on stopped VMs, which cannot be asked. */
  readonly knownWorkspaceRoots: (sandboxId: string) => ReadonlyArray<string>;
  readonly report: ReportStep;
  readonly onCreated?: (sandbox: BoatSandbox) => Effect.Effect<void>;
  /** Runs before an existing VM is resumed or reused, so an idle sweep leaves it on. */
  readonly onReused?: (sandboxId: string) => Effect.Effect<void>;
}) {
  const { api, repository, report } = input;
  yield* report("machine", "active", "Looking for a VM");
  const choice = yield* Effect.gen(function* () {
    const sandboxes = yield* api.listSandboxes(MACHINE_LABEL_FILTER);
    const candidates = yield* Effect.forEach(
      sandboxes.filter((sandbox) => machineStateOf(sandbox.state) !== "starting"),
      (sandbox): Effect.Effect<MachineCandidate> => {
        const running = machineStateOf(sandbox.state) === "running";
        const environment = sandbox.environment ?? null;
        if (!running) {
          return Effect.succeed({
            sandboxId: sandbox.id,
            environment,
            running,
            usage: null,
            workspaceRoots: input.knownWorkspaceRoots(sandbox.id),
          });
        }
        return exec(api, sandbox.id, measureScript, 20).pipe(
          Effect.map(parseMeasure),
          Effect.orElseSucceed(() => null),
          Effect.map((measure) => ({
            sandboxId: sandbox.id,
            environment,
            running,
            usage: measure?.usage ?? null,
            workspaceRoots: measure?.workspaceRoots ?? [],
          })),
        );
      },
      { concurrency: 8 },
    );
    return pickMachine(candidates, repository.workspaceRoot, input.environment);
  }).pipe(Effect.tapError(() => report("machine", "failed", "Looking for a VM")));

  const machineDetail =
    choice.kind === "create"
      ? "Creating a VM from the snapshot"
      : choice.kind === "resume"
        ? `Resuming ${machineLabelOf(choice.sandboxId)}`
        : `Using ${machineLabelOf(choice.sandboxId)}`;
  const sandboxId = yield* runStep(
    report,
    "machine",
    machineDetail,
    Effect.gen(function* () {
      let id: string;
      if (choice.kind === "create") {
        const created = yield* api.createSandbox({
          name: "Boat cloud",
          // Several threads share a VM, so it gets the medium size.
          type: "default",
          labels: MACHINE_LABELS,
          from: BOAT_CLOUD_SNAPSHOT_NAME,
          ttlSeconds: IDLE_TTL_SECONDS,
          ...(input.environment === null ? {} : { environment: input.environment }),
        });
        if (input.onCreated) yield* input.onCreated(created);
        id = created.id;
      } else if (choice.kind === "resume") {
        if (input.onReused) yield* input.onReused(choice.sandboxId);
        // No environment on resume: Boat keeps the VM on the one it started with.
        yield* api.resume(choice.sandboxId, IDLE_TTL_SECONDS);
        id = choice.sandboxId;
      } else {
        if (input.onReused) yield* input.onReused(choice.sandboxId);
        // A reused VM may be minutes from its deadline; the new thread restarts it.
        yield* api.extend(choice.sandboxId, IDLE_TTL_SECONDS);
        id = choice.sandboxId;
      }
      yield* waitRunning(api, id);
      return id;
    }),
  );

  // The server and the checkout are independent until the project is added.
  const [server] = yield* Effect.all(
    [
      runStep(
        report,
        "server",
        null,
        Effect.gen(function* () {
          const environmentId = yield* ensureServer(api, sandboxId);
          const httpBaseUrl = yield* hostServer(api, sandboxId);
          return { environmentId, httpBaseUrl };
        }),
      ),
      runStep(
        report,
        "repository",
        repository.name,
        exec(api, sandboxId, checkoutScript(repository, input.baseBranch), 600).pipe(
          Effect.mapError((error) => cloneFailure(error, repository.name)),
        ),
      ),
    ],
    { concurrency: 2 },
  );
  const pairingCode = yield* pair(api, sandboxId, repository.workspaceRoot);
  return {
    sandboxId,
    environmentId: server.environmentId,
    httpBaseUrl: server.httpBaseUrl,
    pairingCode,
    workspaceRoot: repository.workspaceRoot,
    created: choice.kind === "create",
  } satisfies StartedMachine;
});

/** The Boat VM a paired environment's URL points at, or null when Boat has no such VM. */
export const findSandboxByHttpBaseUrl = Effect.fn("BoatCloud.findSandboxByHttpBaseUrl")(function* (
  api: BoatApi,
  httpBaseUrl: string,
) {
  const subdomain = subdomainOfHttpBaseUrl(httpBaseUrl);
  if (subdomain === null) return null;
  const sandboxes = yield* api.listSandboxes(MACHINE_LABEL_FILTER);
  return sandboxes.find((sandbox) => sandbox.subdomain === subdomain) ?? null;
});

/**
 * Turns a stopped VM back on and serves its T3 server again. The disk keeps
 * the server's identity, so clients already paired with it reconnect by themselves.
 */
export const wakeMachine = Effect.fn("BoatCloud.wakeMachine")(function* (
  api: BoatApi,
  sandboxId: string,
) {
  const sandbox = yield* api.getSandbox(sandboxId);
  if (sandbox === null) return yield* vmFailure("Boat deleted this VM.", "gone");
  if (machineStateOf(sandbox.state) === "stopped") {
    yield* api.resume(sandboxId, IDLE_TTL_SECONDS);
  } else {
    yield* api.extend(sandboxId, IDLE_TTL_SECONDS);
  }
  yield* waitRunning(api, sandboxId);
  const environmentId = yield* ensureServer(api, sandboxId);
  const httpBaseUrl = yield* hostServer(api, sandboxId);
  return { environmentId, httpBaseUrl };
});

/** A pairing code for a VM that is running, such as one just woken from a backup. */
export const issuePairing = (api: BoatApi, sandboxId: string) => pair(api, sandboxId, null);

const waitSnapshot = (api: BoatApi) =>
  api.getSnapshotStatus(BOAT_CLOUD_SNAPSHOT_NAME).pipe(
    Effect.flatMap((status) => {
      if (status === "ready") return Effect.void;
      if (status === "failed") return Effect.fail(vmFailure("Boat could not save the snapshot."));
      return Effect.fail(vmFailure("Boat is still saving the snapshot.", "saving"));
    }),
    Effect.retry({
      schedule: Schedule.spaced(Duration.seconds(5)),
      times: 360,
      while: (error) => error.code === "saving",
    }),
  );

/**
 * Builds the snapshot every VM starts from: a VM with T3 Code installed as a
 * service that starts at boot, the holder's skills, and no T3 state.
 */
export const buildSnapshot = Effect.fn("BoatCloud.buildSnapshot")(function* (input: {
  readonly api: BoatApi;
  readonly install: (sandboxId: string) => Effect.Effect<void, BoatApiError>;
  /** Absent on a holder with no skills of its own, such as the phone. */
  readonly copySkills?: (sandboxId: string) => Effect.Effect<void, BoatApiError>;
  readonly setStep: (step: BoatCloudSetupStep) => Effect.Effect<void>;
}) {
  const { api } = input;
  yield* input.setStep("create-vm");
  // A setup that died midway leaves its VM behind.
  for (const leftover of yield* api.listSandboxes(SETUP_LABEL_FILTER)) {
    yield* api.delete(leftover.id);
  }
  const created = yield* api.createSandbox({
    name: "T3 Code setup",
    type: "small",
    labels: SETUP_LABELS,
    ttlSeconds: 60 * 60,
    // Not noEnv: Boat carries it into the snapshot, and VMs made from it get no credentials.
  });
  yield* Effect.gen(function* () {
    yield* waitRunning(api, created.id);
    yield* input.setStep("install-server");
    yield* input.install(created.id);
    yield* ensureServer(api, created.id);
    yield* input.setStep("copy-skills");
    if (input.copySkills) yield* input.copySkills(created.id);
    yield* input.setStep("save-snapshot");
    yield* exec(api, created.id, prepareSnapshotScript);
    yield* api.saveSnapshot(created.id, BOAT_CLOUD_SNAPSHOT_NAME);
    yield* waitSnapshot(api);
  }).pipe(Effect.ensuring(api.delete(created.id).pipe(Effect.ignore)));
});
