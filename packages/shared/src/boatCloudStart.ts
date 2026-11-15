import {
  BOAT_CLOUD_SNAPSHOT_NAME,
  type BoatCloudSetupStep,
  type BoatCloudStartStep,
  type BoatCloudStepProgress,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  type BoatApi,
  BoatApiError,
  type BoatCommandResult,
  type BoatSandbox,
} from "./boatCloudApi.ts";
import {
  BASE_BRANCH_MISSING_EXIT,
  IDLE_TTL_SECONDS,
  type MachineCandidate,
  MACHINE_LABEL_FILTER,
  MACHINE_LABELS,
  PAIRING_MARKER,
  type ParsedRepository,
  SETUP_LABEL_FILTER,
  SETUP_LABELS,
  VM_T3_PORT,
  checkoutScript,
  machineLabelOf,
  machineStateOf,
  measureScript,
  parseMeasure,
  pairScript,
  pickMachine,
  prepareSnapshotScript,
  startServerScript,
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

export const vmFailure = (message: string, code = "vm", cause?: unknown) =>
  new BoatApiError({ status: 0, code, message, retryable: false, cause });

/** The command's output stays in `cause`; `failure` names what did not work. */
const commandFailure = (result: BoatCommandResult, failure?: string) =>
  vmFailure(
    failure ??
      (result.timedOut
        ? "A command on the VM timed out."
        : `A command on the VM exited with ${result.exitCode}.`),
    "vm",
    result,
  );

export const exec = (
  api: BoatApi,
  sandboxId: string,
  script: string,
  timeoutSeconds = 120,
  failure?: string,
) =>
  api
    .exec(sandboxId, script, timeoutSeconds)
    .pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout ?? "")
          : Effect.fail(commandFailure(result, failure)),
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
      schedule: Schedule.spaced(Duration.millis(250)),
      times: 1200,
      while: (error) => error.code === "starting",
    }),
  );

const PAIRING_LABEL = "Boat cloud";

const pairingOf = (output: string): Effect.Effect<string, BoatApiError> =>
  Option.match(decodePairing(output), {
    onNone: () => Effect.fail(vmFailure("T3 Code on the VM did not issue a pairing code.")),
    onSome: (pairing) => Effect.succeed(pairing.credential),
  });

/** Starts the server and, when asked, mints a pairing code in the same command. */
const startServer = Effect.fn("BoatCloud.startServer")(function* (
  api: BoatApi,
  sandboxId: string,
  pair: boolean,
) {
  const output = yield* exec(
    api,
    sandboxId,
    startServerScript(pair ? PAIRING_LABEL : null),
    90,
    "T3 Code did not start on the VM.",
  );
  const markerAt = output.indexOf(PAIRING_MARKER);
  const descriptor = decodeDescriptor(
    (markerAt === -1 ? output : output.slice(0, markerAt)).trim(),
  );
  if (Option.isNone(descriptor)) {
    return yield* vmFailure("T3 Code on the VM did not describe itself.");
  }
  const pairingCode = pair
    ? yield* pairingOf(output.slice(markerAt + PAIRING_MARKER.length))
    : null;
  return { environmentId: descriptor.value.environmentId, pairingCode };
});

const ensureServer = (api: BoatApi, sandboxId: string) =>
  startServer(api, sandboxId, false).pipe(Effect.map((started) => started.environmentId));

/** Boat routes a hosted port only when it is registered after the server listens on it. */
const hostServer = (api: BoatApi, sandboxId: string) =>
  api.host(sandboxId, VM_T3_PORT).pipe(
    Effect.map((url) => {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    }),
  );

const pair = (api: BoatApi, sandboxId: string) =>
  exec(
    api,
    sandboxId,
    pairScript(PAIRING_LABEL),
    60,
    "T3 Code on the VM did not issue a pairing code.",
  ).pipe(Effect.flatMap(pairingOf));

/** Boat serves the hosted port here once it is registered; the list carries the subdomain. */
const hostedUrlOf = (sandbox: BoatSandbox) =>
  sandbox.subdomain ? `https://${sandbox.subdomain}-${VM_T3_PORT}.on.boat.dev` : null;

const GIT_AUTH_FAILURE = /could not read Username|Authentication failed|Repository not found/u;

/**
 * Gets the checkout and adds it as a project. Boat clones with the GitHub access set
 * up in its dashboard; without it git only says it cannot log in.
 */
const checkout = (
  api: BoatApi,
  sandboxId: string,
  repository: ParsedRepository,
  baseBranch: string | null,
) =>
  api.exec(sandboxId, checkoutScript(repository, baseBranch), 600).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.void;
      if (baseBranch !== null && result.exitCode === BASE_BRANCH_MISSING_EXIT) {
        return Effect.fail(
          vmFailure(
            `${baseBranch} is not on ${repository.name}. Push it, or start from a pushed branch.`,
            "base_branch",
            result,
          ),
        );
      }
      if (GIT_AUTH_FAILURE.test(result.stderr ?? "")) {
        return Effect.fail(
          vmFailure(
            `Boat cannot clone ${repository.name}. Connect GitHub in the Boat dashboard, under Environments.`,
            "clone",
            result,
          ),
        );
      }
      return Effect.fail(commandFailure(result, `Could not get ${repository.name} on the VM.`));
    }),
  );

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
  /** Null when the client already paired with this VM and only reconnects. */
  readonly pairingCode: string | null;
  readonly workspaceRoot: string;
  readonly created: boolean;
  /** The checkout and its project, still running: the client connects meanwhile. */
  readonly checkout: Effect.Effect<void, BoatApiError>;
}

/** A VM the client already paired with, by the URL it reaches it at. */
export interface PairedEnvironment {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
}

/**
 * Picks a VM for the repository (a free running one, then a stopped one, then a
 * new one from the snapshot), then starts its server while it clones the
 * checkout. Returns once the server answers: a client already paired with the
 * VM reconnects, any other gets a pairing code, and the checkout carries on.
 */
export const startMachine = Effect.fn("BoatCloud.startMachine")(function* (input: {
  readonly api: BoatApi;
  readonly repository: ParsedRepository;
  /** The thread's base branch, which must be on the remote. */
  readonly baseBranch: string | null;
  /** The Boat environment a new VM starts on and a reused one must already run; Boat's default when null. */
  readonly environment: string | null;
  /** Boat's list of VMs, when the caller just read it. */
  readonly sandboxes?: ReadonlyArray<BoatSandbox>;
  /** Checkouts the holder remembers on stopped VMs, which cannot be asked. */
  readonly knownWorkspaceRoots: (sandboxId: string) => ReadonlyArray<string>;
  readonly paired?: ReadonlyArray<PairedEnvironment>;
  readonly report: ReportStep;
  readonly onCreated?: (sandbox: BoatSandbox) => Effect.Effect<void>;
  /** Runs before an existing VM is resumed or reused, so an idle sweep leaves it on. */
  readonly onReused?: (sandboxId: string) => Effect.Effect<void>;
}) {
  const { api, repository, report } = input;
  yield* report("machine", "active", "Looking for a VM");
  const { choice, sandboxes } = yield* Effect.gen(function* () {
    const sandboxes = input.sandboxes ?? (yield* api.listSandboxes(MACHINE_LABEL_FILTER));
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
        // The load decides between sharing this VM and starting another, even when it is the only one.
        return exec(api, sandbox.id, measureScript(repository.workspaceRoot), 20).pipe(
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
    return {
      choice: pickMachine(candidates, repository.workspaceRoot, input.environment),
      sandboxes,
    };
  }).pipe(Effect.tapError(() => report("machine", "failed", "Looking for a VM")));

  const machineDetail =
    choice.kind === "create"
      ? "Creating a VM from the snapshot"
      : choice.kind === "resume"
        ? `Resuming ${machineLabelOf(choice.sandboxId)}`
        : `Using ${machineLabelOf(choice.sandboxId)}`;
  const sandbox = yield* runStep(
    report,
    "machine",
    machineDetail,
    Effect.gen(function* () {
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
        return yield* waitRunning(api, created.id);
      }
      if (input.onReused) yield* input.onReused(choice.sandboxId);
      if (choice.kind === "resume") {
        // No environment on resume: Boat keeps the VM on the one it started with.
        yield* api.resume(choice.sandboxId, IDLE_TTL_SECONDS);
        return yield* waitRunning(api, choice.sandboxId);
      }
      // Listed running a moment ago, so it needs no wait. The new deadline is set
      // alongside the server start below.
      return sandboxes.find((listed) => listed.id === choice.sandboxId)!;
    }),
  );
  const sandboxId = sandbox.id;

  // Its failure carries the reason, since the client learns it from the step alone.
  const checkoutFiber = yield* report("repository", "active", repository.name).pipe(
    Effect.andThen(checkout(api, sandboxId, repository, input.baseBranch)),
    Effect.tap(() => report("repository", "done", repository.name)),
    Effect.tapError((error) => report("repository", "failed", error.message)),
    Effect.forkDetach,
  );

  // A client paired with this VM reconnects with its saved credential, so it needs no new code.
  const expected = sandbox.subdomain
    ? (input.paired?.find(
        (environment) => subdomainOfHttpBaseUrl(environment.httpBaseUrl) === sandbox.subdomain,
      ) ?? null)
    : null;
  const server = yield* runStep(
    report,
    "server",
    null,
    Effect.gen(function* () {
      // A reused VM may be minutes from its deadline; the new thread restarts it.
      const [started] = yield* Effect.all(
        [
          startServer(api, sandboxId, expected === null),
          choice.kind === "use" ? api.extend(sandboxId, IDLE_TTL_SECONDS) : Effect.void,
        ],
        { concurrency: 2 },
      );
      // Its state was reset since the client paired, so the saved credential no longer works.
      const pairingCode =
        expected !== null && started.environmentId !== expected.environmentId
          ? yield* pair(api, sandboxId)
          : started.pairingCode;
      // Boat keeps a hosted port across server restarts but not across a stop.
      const listedUrl = choice.kind === "use" ? hostedUrlOf(sandbox) : null;
      const httpBaseUrl = listedUrl ?? (yield* hostServer(api, sandboxId));
      return { environmentId: started.environmentId, pairingCode, httpBaseUrl };
    }),
  ).pipe(Effect.onError(() => Fiber.interrupt(checkoutFiber)));
  return {
    sandboxId,
    environmentId: server.environmentId,
    httpBaseUrl: server.httpBaseUrl,
    pairingCode: server.pairingCode,
    workspaceRoot: repository.workspaceRoot,
    created: choice.kind === "create",
    checkout: Fiber.join(checkoutFiber),
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
  options?: { readonly pair: boolean },
) {
  const sandbox = yield* api.getSandbox(sandboxId);
  if (sandbox === null) return yield* vmFailure("Boat deleted this VM.", "gone");
  if (machineStateOf(sandbox.state) === "stopped") {
    yield* api.resume(sandboxId, IDLE_TTL_SECONDS);
  } else {
    yield* api.extend(sandboxId, IDLE_TTL_SECONDS);
  }
  yield* waitRunning(api, sandboxId);
  const started = yield* startServer(api, sandboxId, options?.pair === true);
  const httpBaseUrl = yield* hostServer(api, sandboxId);
  return { ...started, httpBaseUrl };
});

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
