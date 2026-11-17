import {
  type BoatCloudSetupStep,
  type BoatCloudStartStep,
  type BoatCloudStepProgress,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { type HttpClient, HttpClientResponse } from "effect/http";

import {
  type BoatApi,
  BoatApiError,
  type BoatCommandResult,
  type BoatSandbox,
  type BoatSnapshot,
} from "./boatCloudApi.ts";
import {
  BASE_BRANCH_MISSING_EXIT,
  CLI_RELEASE_REPOSITORY,
  IDLE_TTL_SECONDS,
  type MachineCandidate,
  MACHINE_LABEL_FILTER,
  MACHINE_LABELS,
  MACHINE_NAME,
  NOT_HOSTED_MARKER,
  PAIRING_MARKER,
  type ParsedRepository,
  type PreparedWorktree,
  SNAPSHOT_LABEL,
  SPARE_NAME,
  SPARE_TTL_SECONDS,
  SETUP_LABEL_FILTER,
  SETUP_LABELS,
  VM_T3_PORT,
  checkoutScript,
  cliVersionOfTag,
  cloneRepositoriesScript,
  installCliScript,
  isBoatCloudSnapshot,
  machineLabelOf,
  machineStateOf,
  measureScript,
  parseMeasure,
  pairScript,
  parkWorktreesScript,
  parseRepository,
  pickMachine,
  prepareSnapshotScript,
  snapshotNameOf,
  startServerScript,
  stockPairingScript,
  subdomainOfHttpBaseUrl,
  worktreePathOf,
} from "./boatCloudVm.ts";
import { buildTemporaryWorktreeBranchName } from "./git.ts";

/**
 * Getting a Boat cloud VM ready for a thread. Every holder of the Boat key runs
 * these: a server for the clients connected to it, or the phone on its own.
 */

const decodeDescriptor = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ environmentId: EnvironmentId })),
);
const decodePairing = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.String, expiresAt: Schema.String })),
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

const pairingOf = (output: string) =>
  Option.match(decodePairing(output), {
    onNone: () => Effect.fail(vmFailure("T3 Code on the VM did not issue a pairing code.")),
    onSome: (pairing) =>
      Effect.succeed({ code: pairing.credential, expiresAt: Date.parse(pairing.expiresAt) }),
  });

/**
 * Starts the server and, when asked, mints a pairing code good for at least `minutes` in
 * the same command. `hosted` is false when the VM could not serve its port by itself.
 */
const startServer = Effect.fn("BoatCloud.startServer")(function* (
  api: BoatApi,
  sandboxId: string,
  pair: boolean,
  minutes?: number,
) {
  const output = yield* exec(
    api,
    sandboxId,
    startServerScript(pair ? PAIRING_LABEL : null, minutes),
    90,
    "T3 Code did not start on the VM.",
  );
  const markerAt = output.indexOf(PAIRING_MARKER);
  const head = markerAt === -1 ? output : output.slice(0, markerAt);
  const hosted = !head.includes(NOT_HOSTED_MARKER);
  const descriptor = decodeDescriptor(head.replace(NOT_HOSTED_MARKER, "").trim());
  if (Option.isNone(descriptor)) {
    return yield* vmFailure("T3 Code on the VM did not describe itself.");
  }
  const pairing = pair ? yield* pairingOf(output.slice(markerAt + PAIRING_MARKER.length)) : null;
  return { environmentId: descriptor.value.environmentId, pairing, hosted };
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
  ).pipe(
    Effect.flatMap(pairingOf),
    Effect.map((pairing) => pairing.code),
  );

/** Where Boat serves the port the VM hosted, asking Boat to host it only when the VM could not. */
const serverUrl = (api: BoatApi, sandbox: BoatSandbox, hosted: boolean) =>
  hosted && sandbox.subdomain
    ? Effect.succeed(`https://${sandbox.subdomain}-${VM_T3_PORT}.on.boat.dev`)
    : hostServer(api, sandbox.id);

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
  worktree: PreparedWorktree | null,
) =>
  api.exec(sandboxId, checkoutScript(repository, baseBranch, worktree), 600).pipe(
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
  /** The thread's worktree, ready once `checkout` is; null without a base branch. */
  readonly worktree: PreparedWorktree | null;
  readonly created: boolean;
  /** The checkout, the worktree and the project, still running: the client connects meanwhile. */
  readonly checkout: Effect.Effect<void, BoatApiError>;
}

/** A VM the client already paired with, by the URL it reaches it at. */
export interface PairedEnvironment {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
}

/**
 * A running spare with its server up, hosted, and a pairing code the holder took for it,
 * so a start hands it out with no call to Boat.
 */
export interface ReadySpare {
  readonly sandboxId: string;
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
  readonly pairingCode: string;
  readonly snapshot: string;
  readonly environment: string | null;
  /** Epoch milliseconds the pairing code expires at. */
  readonly codeExpiresAt: number;
  /** Epoch milliseconds Boat may stop the VM from. */
  readonly stopsAt: number;
}

interface StartMachineInput {
  readonly api: BoatApi;
  readonly repository: ParsedRepository;
  /** The thread's base branch, which must be on the remote. */
  readonly baseBranch: string | null;
  /** The Boat environment a new VM starts on and a reused one must already run; Boat's default when null. */
  readonly environment: string | null;
  /** The saved snapshot a new VM starts from, from `startingSnapshot`. */
  readonly snapshot: string;
  /** The spare the holder took from its `makeSpareKeeper`; the start then asks Boat nothing first. */
  readonly readySpare?: ReadySpare | null;
  /** Boat's list of VMs, when the caller just read it. */
  readonly sandboxes?: ReadonlyArray<BoatSandbox>;
  /** Checkouts the holder remembers on stopped VMs, which cannot be asked. */
  readonly knownWorkspaceRoots: (sandboxId: string) => ReadonlyArray<string>;
  readonly paired?: ReadonlyArray<PairedEnvironment>;
  readonly report: ReportStep;
  /** Runs once a VM joins the holder's machines: one it created, or the spare it took. */
  readonly onAdded?: (sandboxId: string) => Effect.Effect<void>;
  /** Runs before an existing VM is resumed or reused, so an idle sweep leaves it on. */
  readonly onReused?: (sandboxId: string) => Effect.Effect<void>;
}

/**
 * Cuts the thread's worktree name and starts the checkout, together with `alongside`.
 * Its failure carries the reason, since the client learns it from the step alone.
 */
const startCheckout = Effect.fn("BoatCloud.startCheckout")(function* (
  input: StartMachineInput,
  sandboxId: string,
  alongside: Effect.Effect<void> = Effect.void,
) {
  const { api, repository, report } = input;
  // The same temporary name T3 gives a new worktree, so the server renames it after the first message.
  const worktree: PreparedWorktree | null =
    input.baseBranch === null
      ? null
      : yield* Effect.map(Random.next, (random) => {
          const branch = buildTemporaryWorktreeBranchName(() =>
            Math.floor(random * 0x1_0000_0000)
              .toString(16)
              .padStart(8, "0"),
          );
          return {
            path: worktreePathOf(repository, branch),
            branch,
            baseBranch: input.baseBranch!,
          };
        });
  const fiber = yield* report("repository", "active", repository.name).pipe(
    Effect.andThen(checkout(api, sandboxId, repository, input.baseBranch, worktree)),
    Effect.tap(() => report("repository", "done", repository.name)),
    Effect.tapError((error) => report("repository", "failed", error.message)),
    (effect) => Effect.all([effect, alongside], { concurrency: 2, discard: true }),
    Effect.forkDetach,
  );
  return { worktree, fiber };
});

/**
 * Hands out the spare the holder holds. The rename that tells other holders it is taken,
 * and the thread's deadline, go to Boat alongside the checkout, after the client has
 * what it needs to connect.
 */
const handOutSpare = Effect.fn("BoatCloud.handOutSpare")(function* (
  input: StartMachineInput,
  spare: ReadySpare,
) {
  const { api, report } = input;
  const { sandboxId } = spare;
  yield* report("machine", "done", "Using a ready VM");
  if (input.onAdded) yield* input.onAdded(sandboxId);
  if (input.onReused) yield* input.onReused(sandboxId);
  const claim = Effect.all(
    [api.rename(sandboxId, MACHINE_NAME), api.extend(sandboxId, IDLE_TTL_SECONDS)],
    { concurrency: 2, discard: true },
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("boat cloud could not claim the spare it handed out", { sandboxId, cause }),
    ),
  );
  const { worktree, fiber } = yield* startCheckout(input, sandboxId, claim);
  yield* report("server", "done", null);
  return {
    sandboxId,
    environmentId: spare.environmentId,
    httpBaseUrl: spare.httpBaseUrl,
    pairingCode: spare.pairingCode,
    workspaceRoot: input.repository.workspaceRoot,
    worktree,
    created: false,
    checkout: Fiber.join(fiber),
  } satisfies StartedMachine;
});

/**
 * Hands out the holder's ready spare, else picks a VM (a free running one or the spare, a
 * stopped one, a new one) and starts its server while the checkout runs. Returns once the
 * server answers: a paired client reconnects, any other gets a code, the checkout carries on.
 */
export const startMachine = Effect.fn("BoatCloud.startMachine")(function* (
  input: StartMachineInput,
) {
  if (input.readySpare) return yield* handOutSpare(input, input.readySpare);
  const { api, repository, report } = input;
  yield* report("machine", "active", "Looking for a VM");
  const { choice, sandboxes } = yield* Effect.gen(function* () {
    const sandboxes = input.sandboxes ?? (yield* api.listSandboxes(MACHINE_LABEL_FILTER));
    const candidates = yield* Effect.forEach(
      sandboxes.filter((sandbox) => machineStateOf(sandbox.state) !== "starting"),
      (sandbox): Effect.Effect<MachineCandidate> => {
        const running = machineStateOf(sandbox.state) === "running";
        const environment = sandbox.environment ?? null;
        const spare = sandbox.name === SPARE_NAME;
        if (!running) {
          return Effect.succeed({
            sandboxId: sandbox.id,
            environment,
            running,
            usage: null,
            workspaceRoots: input.knownWorkspaceRoots(sandbox.id),
            spare,
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
            spare,
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

  const spare =
    choice.kind !== "create" &&
    sandboxes.find((listed) => listed.id === choice.sandboxId)?.name === SPARE_NAME;
  const machineDetail =
    choice.kind === "create"
      ? "Creating a VM from the snapshot"
      : choice.kind === "resume"
        ? `Resuming ${machineLabelOf(choice.sandboxId)}`
        : spare
          ? "Using a ready VM"
          : `Using ${machineLabelOf(choice.sandboxId)}`;
  const runningSpare = spare && choice.kind === "use";
  const join = Effect.fn("BoatCloud.joinMachine")(function* (sandboxId: string) {
    if (spare) {
      // The name is all that marks a spare, so no other holder takes it from here on.
      yield* api.rename(sandboxId, MACHINE_NAME);
      if (input.onAdded) yield* input.onAdded(sandboxId);
    }
    if (input.onReused) yield* input.onReused(sandboxId);
  });
  const sandbox = yield* runStep(
    report,
    "machine",
    machineDetail,
    Effect.gen(function* () {
      if (choice.kind === "create") {
        const created = yield* api.createSandbox({
          name: MACHINE_NAME,
          // Several threads share a VM, so it gets the medium size.
          type: "default",
          labels: { ...MACHINE_LABELS, [SNAPSHOT_LABEL]: input.snapshot },
          from: input.snapshot,
          ttlSeconds: IDLE_TTL_SECONDS,
          ...(input.environment === null ? {} : { environment: input.environment }),
        });
        if (input.onAdded) yield* input.onAdded(created.id);
        return yield* waitRunning(api, created.id);
      }
      // A running spare joins alongside its server start below.
      if (!runningSpare) yield* join(choice.sandboxId);
      if (choice.kind === "resume") {
        // No environment on resume: Boat keeps the VM on the one it started with. A small
        // spare grows to the shared size here.
        yield* api.resume(choice.sandboxId, IDLE_TTL_SECONDS, "default");
        return yield* waitRunning(api, choice.sandboxId);
      }
      // Listed running a moment ago, so it needs no wait. The new deadline is set
      // alongside the server start below.
      return sandboxes.find((listed) => listed.id === choice.sandboxId)!;
    }),
  );
  const sandboxId = sandbox.id;
  const { worktree, fiber: checkoutFiber } = yield* startCheckout(input, sandboxId);

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
          runningSpare ? join(sandboxId) : Effect.void,
        ],
        { concurrency: "unbounded" },
      );
      // Its state was reset since the client paired, so the saved credential no longer works.
      const pairingCode =
        expected !== null && started.environmentId !== expected.environmentId
          ? yield* pair(api, sandboxId)
          : (started.pairing?.code ?? null);
      const httpBaseUrl = yield* serverUrl(api, sandbox, started.hosted);
      return { environmentId: started.environmentId, pairingCode, httpBaseUrl };
    }),
  ).pipe(Effect.onError(() => Fiber.interrupt(checkoutFiber)));
  return {
    sandboxId,
    environmentId: server.environmentId,
    httpBaseUrl: server.httpBaseUrl,
    pairingCode: server.pairingCode,
    workspaceRoot: repository.workspaceRoot,
    worktree,
    created: choice.kind === "create",
    checkout: Fiber.join(checkoutFiber),
  } satisfies StartedMachine;
});

/** Both return at once and carry on in the background on the VM. */
const warmSpareScript = `${stockPairingScript(PAIRING_LABEL)}
${parkWorktreesScript}`;

/** A held spare is handed out only while its code and its deadline last this much longer. */
const HAND_OUT_MARGIN_MS = 2 * 60 * 1000;
/** The code a holder takes for its spare outlives the spare's deadline by this much. */
const HOLD_MINUTES = SPARE_TTL_SECONDS / 60 + 5;

/**
 * Keeps one small spare from the current snapshot and environment ready: server up, hosted,
 * a code taken for the holder, worktrees parked. A held spare whose code outlasts the new
 * deadline only gets the deadline. Other spares are removed.
 */
const ensureSpare = Effect.fn("BoatCloud.ensureSpare")(function* (input: {
  readonly api: BoatApi;
  readonly snapshot: string;
  readonly environment: string | null;
  /** The spare this holder holds a code for. */
  readonly held: ReadySpare | null;
  /** Spares this holder handed out that Boat may still list under the spare's name. */
  readonly taken: ReadonlySet<string>;
}) {
  const { api, held } = input;
  const spares = (yield* api.listSandboxes(MACHINE_LABEL_FILTER)).filter(
    (sandbox) => sandbox.name === SPARE_NAME && !input.taken.has(sandbox.id),
  );
  const fits = (sandbox: BoatSandbox) =>
    sandbox.labels?.[SNAPSHOT_LABEL] === input.snapshot &&
    (input.environment === null || sandbox.environment === input.environment);
  const kept =
    spares.find((sandbox) => sandbox.id === held?.sandboxId && fits(sandbox)) ??
    spares.find(fits) ??
    null;
  yield* Effect.forEach(
    spares.filter((sandbox) => sandbox !== kept),
    (sandbox) => api.delete(sandbox.id),
    { concurrency: "unbounded", discard: true },
  );
  const stopsAt = (yield* Clock.currentTimeMillis) + SPARE_TTL_SECONDS * 1000;
  if (
    kept !== null &&
    held?.sandboxId === kept.id &&
    machineStateOf(kept.state) === "running" &&
    held.codeExpiresAt - stopsAt > HAND_OUT_MARGIN_MS
  ) {
    // A client just looked, so a start may follow: the parked worktrees catch up meanwhile.
    yield* Effect.all(
      [
        api.extend(kept.id, SPARE_TTL_SECONDS),
        exec(api, kept.id, warmSpareScript, 30).pipe(Effect.ignore),
      ],
      { concurrency: 2, discard: true },
    );
    return { ...held, stopsAt } satisfies ReadySpare;
  }
  let sandboxId: string;
  if (kept === null) {
    const created = yield* api.createSandbox({
      name: SPARE_NAME,
      type: "small",
      labels: { ...MACHINE_LABELS, [SNAPSHOT_LABEL]: input.snapshot },
      from: input.snapshot,
      ttlSeconds: SPARE_TTL_SECONDS,
      ...(input.environment === null ? {} : { environment: input.environment }),
    });
    sandboxId = created.id;
  } else if (machineStateOf(kept.state) === "stopped") {
    yield* api.resume(kept.id, SPARE_TTL_SECONDS);
    sandboxId = kept.id;
  } else {
    // Running, or starting under the holder that made it.
    yield* api.extend(kept.id, SPARE_TTL_SECONDS);
    sandboxId = kept.id;
  }
  const sandbox = yield* waitRunning(api, sandboxId);
  const started = yield* startServer(api, sandboxId, true, HOLD_MINUTES);
  const pairing =
    started.pairing ?? (yield* vmFailure("T3 Code on the VM did not issue a pairing code."));
  const [httpBaseUrl] = yield* Effect.all(
    [serverUrl(api, sandbox, started.hosted), exec(api, sandboxId, warmSpareScript, 30)],
    { concurrency: 2 },
  );
  return {
    sandboxId,
    environmentId: started.environmentId,
    httpBaseUrl,
    pairingCode: pairing.code,
    snapshot: input.snapshot,
    environment: input.environment,
    codeExpiresAt: pairing.expiresAt,
    stopsAt,
  } satisfies ReadySpare;
});

/**
 * One holder's spare, kept ready in the background and remembered, so a start takes it
 * without asking Boat what is free. Boat's list, whenever the holder reads it, drops a
 * spare another holder took, or that stopped or went away.
 */
export const makeSpareKeeper = () => {
  let ready: ReadySpare | null = null;
  const taken = new Set<string>();
  let keeping = false;
  /** A keep asked for while one ran, run once that one ends since a start may have taken its spare. */
  let queued: Effect.Effect<void> | null = null;

  const keep = (api: BoatApi, snapshot: string, environment: string | null): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (keeping) {
        queued = keep(api, snapshot, environment);
        return Effect.void;
      }
      keeping = true;
      return ensureSpare({ api, snapshot, environment, held: ready, taken }).pipe(
        Effect.tap((spare) =>
          Effect.sync(() => {
            ready = taken.has(spare.sandboxId) ? null : spare;
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("boat cloud could not keep a spare VM ready", { cause }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            keeping = false;
          }),
        ),
        Effect.andThen(
          Effect.suspend(() => {
            const next = queued;
            queued = null;
            return next ?? Effect.void;
          }),
        ),
      );
    });

  return {
    keep,
    /** The ready spare for this snapshot and environment, which no later start gets. */
    take: (snapshot: string, environment: string | null) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const spare = ready;
        if (
          spare === null ||
          spare.snapshot !== snapshot ||
          spare.environment !== environment ||
          Math.min(spare.codeExpiresAt, spare.stopsAt) - now < HAND_OUT_MARGIN_MS
        ) {
          return null;
        }
        ready = null;
        taken.add(spare.sandboxId);
        return spare;
      }),
    /** Folds in Boat's list of the holder's VMs. */
    reconcile: (sandboxes: ReadonlyArray<BoatSandbox>) => {
      const byId = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));
      const listed = ready === null ? undefined : byId.get(ready.sandboxId);
      if (
        listed === undefined ||
        listed.name !== SPARE_NAME ||
        machineStateOf(listed.state) !== "running"
      ) {
        ready = null;
      }
      for (const sandboxId of taken) {
        if (byId.get(sandboxId)?.name !== SPARE_NAME) taken.delete(sandboxId);
      }
    },
  };
};

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
  options?: { readonly pair?: boolean; readonly report?: ReportStep },
) {
  const report = options?.report ?? (() => Effect.void);
  const sandbox = yield* runStep(
    report,
    "machine",
    null,
    Effect.gen(function* () {
      const listed = yield* api.getSandbox(sandboxId);
      if (listed === null) return yield* vmFailure("Boat deleted this VM.", "gone");
      if (machineStateOf(listed.state) === "stopped") {
        yield* api.resume(sandboxId, IDLE_TTL_SECONDS, "default");
      } else {
        yield* api.extend(sandboxId, IDLE_TTL_SECONDS);
      }
      return yield* waitRunning(api, sandboxId);
    }),
  );
  return yield* runStep(
    report,
    "server",
    null,
    Effect.gen(function* () {
      const started = yield* startServer(api, sandboxId, options?.pair === true);
      return {
        environmentId: started.environmentId,
        pairingCode: started.pairing?.code ?? null,
        httpBaseUrl: yield* serverUrl(api, sandbox, started.hosted),
      };
    }),
  );
});

const LatestRelease = Schema.Struct({ tag_name: Schema.String });

/** The newest Boat cloud build of t3, which every snapshot should carry. */
export const latestCliRelease = Effect.fn("BoatCloud.latestCliRelease")(
  function* (http: HttpClient.HttpClient) {
    const response = yield* http
      .get(`https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases/latest`, {
        headers: { accept: "application/vnd.github+json" },
      })
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const release = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(LatestRelease)),
    );
    const version = cliVersionOfTag(release.tag_name);
    if (version === null) return yield* Effect.fail(release.tag_name);
    return version;
  },
  Effect.timeout(Duration.seconds(30)),
  Effect.mapError((cause) =>
    vmFailure("Could not find the latest T3 Code build for Boat cloud.", "cli_release", cause),
  ),
);

const createdMillis = (snapshot: BoatSnapshot) => Date.parse(snapshot.createdAt ?? "") || 0;

/** The snapshot new VMs start from: the newest ready one, the previous build while one is saved. */
export const startingSnapshot = (snapshots: ReadonlyArray<BoatSnapshot>) => {
  let newest: BoatSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.status !== "ready" || !isBoatCloudSnapshot(snapshot.name)) continue;
    if (newest === null || createdMillis(snapshot) > createdMillis(newest)) newest = snapshot;
  }
  return newest?.name ?? null;
};

/**
 * Whether a holder should save the latest build: a machine wants it with its skills, and
 * a holder without skills, such as the phone, takes any snapshot of it. One being saved
 * counts, so holders never undo each other's work.
 */
export const needsSnapshot = (
  snapshots: ReadonlyArray<BoatSnapshot>,
  version: string,
  withSkills: boolean,
) => {
  const has = (name: string) =>
    snapshots.some((snapshot) => snapshot.name === name && snapshot.status !== "failed");
  return (
    !has(snapshotNameOf(version, true)) && (withSkills || !has(snapshotNameOf(version, false)))
  );
};

/**
 * The build a holder should save a snapshot of, or null when the snapshot is current or
 * another holder is setting one up right now.
 */
export const snapshotToBuild = Effect.fn("BoatCloud.snapshotToBuild")(function* (
  api: BoatApi,
  http: HttpClient.HttpClient,
  withSkills: boolean,
) {
  const [version, snapshots, setups] = yield* Effect.all(
    [latestCliRelease(http), api.listSnapshots(), api.listSandboxes(SETUP_LABEL_FILTER)],
    { concurrency: "unbounded" },
  );
  if (setups.some((sandbox) => machineStateOf(sandbox.state) !== "stopped")) return null;
  return needsSnapshot(snapshots, version, withSkills) ? version : null;
});

// Until Boat starts saving, a name saved before still reports its previous snapshot as ready.
const waitSnapshot = (api: BoatApi, name: string, sourceSandboxId: string) =>
  api.listSnapshots().pipe(
    Effect.flatMap((snapshots) => {
      const snapshot = snapshots.find((candidate) => candidate.name === name);
      if (snapshot?.status === "ready" && snapshot.sourceSandboxId === sourceSandboxId) {
        return Effect.void;
      }
      if (snapshot?.status === "failed") {
        return Effect.fail(vmFailure("Boat could not save the snapshot."));
      }
      return Effect.fail(vmFailure("Boat is still saving the snapshot.", "saving"));
    }),
    Effect.retry({
      schedule: Schedule.spaced(Duration.seconds(5)),
      times: 360,
      while: (error) => error.code === "saving",
    }),
  );

/** Clones what it can; a repository missing from the snapshot is cloned on first use instead. */
const cloneRepositories = (api: BoatApi, sandboxId: string, remoteUrls: ReadonlyArray<string>) => {
  const repositories = [
    ...new Map(
      remoteUrls.flatMap((remoteUrl) => {
        const parsed = parseRepository(remoteUrl);
        return parsed ? [[parsed.key, parsed] as const] : [];
      }),
    ).values(),
  ];
  if (repositories.length === 0) return Effect.void;
  return exec(api, sandboxId, cloneRepositoriesScript(repositories), 300).pipe(
    Effect.flatMap((stdout) =>
      Effect.logInfo("boat cloud snapshot holds repositories", {
        cloned: stdout.split("\n").filter(Boolean).length,
        asked: repositories.length,
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("boat cloud could not clone repositories into the snapshot", { cause }),
    ),
  );
};

/**
 * Builds the snapshot every VM starts from: a VM with the given t3 build installed
 * as a service that starts at boot, the holder's skills, the given repositories
 * checked out, and no T3 state. Older snapshots are deleted once it is saved.
 * Returns its name.
 */
export const buildSnapshot = Effect.fn("BoatCloud.buildSnapshot")(function* (input: {
  readonly api: BoatApi;
  readonly version: string;
  /** Absent on a holder with no skills, such as the phone. */
  readonly copySkills?: (sandboxId: string) => Effect.Effect<void, BoatApiError>;
  /** Remote URLs to check out, so a VM made from the snapshot only fetches them. */
  readonly repositories: ReadonlyArray<string>;
  readonly setStep: (step: BoatCloudSetupStep) => Effect.Effect<void>;
}) {
  const { api } = input;
  const name = snapshotNameOf(input.version, input.copySkills !== undefined);
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
    yield* Effect.all(
      [
        exec(api, created.id, installCliScript(input.version), 600).pipe(
          Effect.andThen(ensureServer(api, created.id)),
        ),
        cloneRepositories(api, created.id, input.repositories),
      ],
      { concurrency: 2 },
    );
    yield* input.setStep("copy-skills");
    if (input.copySkills) yield* input.copySkills(created.id);
    yield* input.setStep("save-snapshot");
    yield* exec(api, created.id, prepareSnapshotScript);
    yield* api.saveSnapshot(created.id, name);
    yield* waitSnapshot(api, name, created.id);
  }).pipe(Effect.ensuring(api.delete(created.id).pipe(Effect.ignore)));
  for (const older of yield* api.listSnapshots()) {
    if (older.name !== name && isBoatCloudSnapshot(older.name)) {
      yield* api.deleteSnapshot(older.name).pipe(Effect.ignore);
    }
  }
  return name;
});
