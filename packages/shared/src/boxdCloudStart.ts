import { type BoatCloudSetupStep, EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/http";

import { type PairedEnvironment, type ReportStep, latestCliRelease } from "./boatCloudStart.ts";
import {
  BASE_BRANCH_MISSING_EXIT,
  type MachineCandidate,
  NOT_HOSTED_MARKER,
  PAIRING_MARKER,
  type ParsedRepository,
  type PreparedWorktree,
  VM_T3_PORT,
  checkoutScript,
  cloneRepositoriesScript,
  installCliScript,
  isBoatCloudSnapshot,
  measureScript,
  parkWorktreesScript,
  parseMeasure,
  parseRepository,
  pickMachine,
  prepareSnapshotScript,
  snapshotNameOf,
  startServerScript,
  stockPairingScript,
  worktreePathOf,
} from "./boatCloudVm.ts";
import { type BoxdApi, BoxdApiError, type BoxdMachine, type BoxdSnapshot } from "./boxdCloudApi.ts";
import { buildTemporaryWorktreeBranchName } from "./git.ts";

/**
 * Getting a boxd machine ready for a thread, with Boat cloud's VM scripts in boxd's home.
 * One spare waits asleep with its server up and a pairing code taken, so a start asks boxd
 * nothing before the client connects, and that connection wakes it in about a second.
 */

/** Boat's scripts assume Boat's home directory; boxd's differs only by name. */
export const onBoxd = (script: string) => script.replaceAll("/home/user", "/home/boxd");

export const parseBoxdRepository = (remoteUrl: string): ParsedRepository | null => {
  const parsed = parseRepository(remoteUrl);
  return parsed === null ? null : { ...parsed, workspaceRoot: onBoxd(parsed.workspaceRoot) };
};

const MACHINE_LABELS = { t3code: "boxd-cloud" } as const;
export const MACHINE_LABEL_FILTER = "t3code=boxd-cloud";
const SETUP_LABELS = { t3code: "boxd-setup" } as const;
const SETUP_LABEL_FILTER = "t3code=boxd-setup";
/** Labels change in place on boxd, so a spare is told apart, and taken, by this one. */
const ROLE_LABEL = "t3code-role";
const SNAPSHOT_LABEL = "t3code-snapshot";
/**
 * A thread machine sleeps after this long without traffic either way. A running turn talks
 * to its provider and a connected client keeps its socket busy, so only a quiet machine sleeps.
 */
const THREAD_HIBERNATE_SECONDS = 15 * 60;
const PAIRING_LABEL = "boxd cloud";
/** The code a spare holds lasts this long; it is renewed once less than the margin is left. */
const SPARE_CODE_MINUTES = 60;
const HAND_OUT_MARGIN_MS = 15 * 60 * 1000;

/**
 * boxd routes HTTPS to the machine's interface, so the server listens on every interface.
 * Pairing still guards it, as on Boat. Written before `t3 service install`, which keeps it.
 */
const LISTEN_EVERYWHERE_SCRIPT = `mkdir -p /home/boxd/.t3
grep -qs '^T3CODE_HOST=' /home/boxd/.t3/service.env || printf 'T3CODE_HOST=0.0.0.0\\n' >> /home/boxd/.t3/service.env`;

export type BoxdMachineState = "running" | "asleep" | "stopped";

export function boxdMachineStateOf(status: string): BoxdMachineState {
  switch (status) {
    case "running":
      return "running";
    case "suspended":
    case "hibernated":
      return "asleep";
    default:
      return "stopped";
  }
}

export const isSpare = (machine: BoxdMachine) => machine.labels[ROLE_LABEL] === "spare";

/** A display name from the machine id, the same on every holder. */
export const boxdMachineLabelOf = (vmId: string) => `boxd cloud ${vmId.slice(0, 4)}`;

const vmFailure = (message: string, code = "vm", cause?: unknown) =>
  new BoxdApiError({ status: 0, code, message, retryable: false, cause });

const exec = (api: BoxdApi, vmId: string, script: string, timeoutSeconds = 120, failure?: string) =>
  api
    .exec(vmId, onBoxd(script), timeoutSeconds)
    .pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              vmFailure(
                failure ?? `A command on the machine exited with ${result.exitCode}.`,
                "vm",
                result,
              ),
            ),
      ),
    );

const decodeDescriptor = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ environmentId: EnvironmentId })),
);
const decodePairing = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.String, expiresAt: Schema.String })),
);

/**
 * Reads `startServerScript` output: the descriptor, then the pairing code when one was asked
 * for. Boat's own hosting step cannot run on boxd and leaves its marker, which means nothing here.
 */
export function parseServerStart(output: string, paired: boolean) {
  const markerAt = output.indexOf(PAIRING_MARKER);
  const head = (markerAt === -1 ? output : output.slice(0, markerAt)).replace(
    NOT_HOSTED_MARKER,
    "",
  );
  const descriptor = decodeDescriptor(head.trim());
  if (Option.isNone(descriptor)) return null;
  if (!paired) return { environmentId: descriptor.value.environmentId, pairing: null };
  if (markerAt === -1) return null;
  const pairing = decodePairing(output.slice(markerAt + PAIRING_MARKER.length).trim());
  if (Option.isNone(pairing)) return null;
  return {
    environmentId: descriptor.value.environmentId,
    pairing: { code: pairing.value.credential, expiresAt: Date.parse(pairing.value.expiresAt) },
  };
}

const startServer = Effect.fn("BoxdCloud.startServer")(function* (
  api: BoxdApi,
  vmId: string,
  pair: boolean,
  minutes?: number,
) {
  const output = yield* exec(
    api,
    vmId,
    startServerScript(pair ? PAIRING_LABEL : null, minutes),
    90,
    "T3 Code did not start on the machine.",
  );
  const started = parseServerStart(output, pair);
  if (started === null) return yield* vmFailure("T3 Code on the machine did not describe itself.");
  return started;
});

const GIT_AUTH_FAILURE = /could not read Username|Authentication failed|Repository not found/u;

const checkout = (
  api: BoxdApi,
  vmId: string,
  repository: ParsedRepository,
  baseBranch: string | null,
  worktree: PreparedWorktree | null,
) =>
  api.exec(vmId, onBoxd(checkoutScript(repository, baseBranch, worktree)), 600).pipe(
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
      if (GIT_AUTH_FAILURE.test(result.stderr)) {
        return Effect.fail(
          vmFailure(
            `boxd cannot clone ${repository.name}. Connect GitHub in boxd, under Integrations.`,
            "clone",
            result,
          ),
        );
      }
      return Effect.fail(
        vmFailure(`Could not get ${repository.name} on the machine.`, "vm", result),
      );
    }),
  );

const runStep = <A, E, R>(
  report: ReportStep,
  step: Parameters<ReportStep>[0],
  detail: string | null,
  effect: Effect.Effect<A, E, R>,
) =>
  report(step, "active", detail).pipe(
    Effect.andThen(effect),
    Effect.tapError(() => report(step, "failed", detail)),
    Effect.tap(() => report(step, "done", detail)),
  );

/** A spare asleep with its server up and a pairing code the holder took for it. */
export interface ReadySpare {
  readonly vmId: string;
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
  readonly pairingCode: string;
  readonly snapshot: string;
  /** Epoch milliseconds the pairing code expires at. */
  readonly codeExpiresAt: number;
}

export interface StartedMachine {
  readonly vmId: string;
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
  readonly pairingCode: string | null;
  readonly workspaceRoot: string;
  readonly worktree: PreparedWorktree | null;
  /** The checkout, the worktree and the project, still running: the client connects meanwhile. */
  readonly checkout: Effect.Effect<void, BoxdApiError>;
}

export interface StartMachineInput {
  readonly api: BoxdApi;
  /** From `parseBoxdRepository`. */
  readonly repository: ParsedRepository;
  readonly baseBranch: string | null;
  readonly snapshot: string;
  readonly readySpare?: ReadySpare | null;
  /** Checkouts the holder remembers on asleep machines, which are not woken to ask. */
  readonly knownWorkspaceRoots: (vmId: string) => ReadonlyArray<string>;
  readonly paired?: ReadonlyArray<PairedEnvironment>;
  readonly report: ReportStep;
}

/** Marks a machine as serving threads; it then sleeps once quiet. */
const claim = (api: BoxdApi, vmId: string) =>
  Effect.all(
    [
      api.updateLabels(vmId, { [ROLE_LABEL]: "thread" }),
      api.setAutoHibernate(vmId, THREAD_HIBERNATE_SECONDS),
    ],
    { concurrency: 2, discard: true },
  );

const startCheckout = Effect.fn("BoxdCloud.startCheckout")(function* (
  input: StartMachineInput,
  vmId: string,
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
            path: onBoxd(worktreePathOf(repository, branch)),
            branch,
            baseBranch: input.baseBranch!,
          };
        });
  const fiber = yield* report("repository", "active", repository.name).pipe(
    Effect.andThen(checkout(api, vmId, repository, input.baseBranch, worktree)),
    Effect.tap(() => report("repository", "done", repository.name)),
    Effect.tapError((error) => report("repository", "failed", error.message)),
    (effect) => Effect.all([effect, alongside], { concurrency: 2, discard: true }),
    Effect.forkDetach,
  );
  return { worktree, fiber };
});

/**
 * Hands out the held spare with no call to boxd first: the client's connection wakes it,
 * and the claim and the checkout run alongside.
 */
const handOutSpare = Effect.fn("BoxdCloud.handOutSpare")(function* (
  input: StartMachineInput,
  spare: ReadySpare,
) {
  yield* input.report("machine", "done", "Using a ready machine");
  const { worktree, fiber } = yield* startCheckout(
    input,
    spare.vmId,
    claim(input.api, spare.vmId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("boxd cloud could not claim the spare it handed out", {
          vmId: spare.vmId,
          cause,
        }),
      ),
    ),
  );
  yield* input.report("server", "done", null);
  return {
    vmId: spare.vmId,
    environmentId: spare.environmentId,
    httpBaseUrl: spare.httpBaseUrl,
    pairingCode: spare.pairingCode,
    workspaceRoot: input.repository.workspaceRoot,
    worktree,
    checkout: Fiber.join(fiber),
  } satisfies StartedMachine;
});

const randomName = (prefix: string) =>
  Effect.map(
    Random.next,
    (random) =>
      `${prefix}-${Math.floor(random * 36 ** 8)
        .toString(36)
        .padStart(8, "0")}`,
  );

/**
 * Hands out the held spare, else picks a machine (a free running one, an asleep one, a new
 * one from the snapshot) and starts its server while the checkout runs. Returns once the
 * server answers: a paired client reconnects, any other gets a code, the checkout carries on.
 */
export const startMachine = Effect.fn("BoxdCloud.startMachine")(function* (
  input: StartMachineInput,
) {
  if (input.readySpare) return yield* handOutSpare(input, input.readySpare);
  const { api, repository, report } = input;
  yield* report("machine", "active", "Looking for a machine");
  const { choice, machines } = yield* Effect.gen(function* () {
    const machines = yield* api.listMachines([MACHINE_LABEL_FILTER]);
    const candidates = yield* Effect.forEach(
      machines,
      (machine): Effect.Effect<MachineCandidate> => {
        const running = boxdMachineStateOf(machine.status) === "running";
        const base = { sandboxId: machine.id, environment: null, running, spare: isSpare(machine) };
        if (!running) {
          return Effect.succeed({
            ...base,
            usage: null,
            workspaceRoots: input.knownWorkspaceRoots(machine.id),
          });
        }
        return exec(api, machine.id, measureScript(repository.workspaceRoot), 20).pipe(
          Effect.map(parseMeasure),
          Effect.orElseSucceed(() => null),
          Effect.map((measure) => ({
            ...base,
            usage: measure?.usage ?? null,
            workspaceRoots: measure?.workspaceRoots ?? [],
          })),
        );
      },
      { concurrency: 8 },
    );
    return { choice: pickMachine(candidates, repository.workspaceRoot, null), machines };
  }).pipe(Effect.tapError(() => report("machine", "failed", "Looking for a machine")));

  const chosen =
    choice.kind === "create" ? null : machines.find((machine) => machine.id === choice.sandboxId)!;
  const detail =
    chosen === null
      ? "Creating a machine from the snapshot"
      : isSpare(chosen)
        ? "Using a ready machine"
        : `Using ${boxdMachineLabelOf(chosen.id)}`;
  const machine = yield* runStep(
    report,
    "machine",
    detail,
    Effect.gen(function* () {
      if (chosen === null) {
        // Copies of the snapshot keep its proxy port and bot setting.
        return yield* api.createMachine({
          name: yield* randomName("t3"),
          labels: { ...MACHINE_LABELS, [ROLE_LABEL]: "thread", [SNAPSHOT_LABEL]: input.snapshot },
          snapshot: input.snapshot,
        });
      }
      // An asleep machine wakes on the next command by itself.
      if (boxdMachineStateOf(chosen.status) === "stopped") yield* api.start(chosen.id);
      return chosen;
    }),
  );
  const { worktree, fiber: checkoutFiber } = yield* startCheckout(input, machine.id);
  const expected =
    input.paired?.find((environment) => environment.httpBaseUrl === machine.url) ?? null;
  const server = yield* runStep(
    report,
    "server",
    null,
    Effect.gen(function* () {
      const [started] = yield* Effect.all(
        [
          startServer(api, machine.id, expected === null),
          chosen === null || isSpare(chosen) || boxdMachineStateOf(chosen.status) !== "running"
            ? claim(api, machine.id)
            : Effect.void,
        ],
        { concurrency: 2 },
      );
      // Its state was reset since the client paired, so the saved credential no longer works.
      if (expected !== null && started.environmentId !== expected.environmentId) {
        const repaired = yield* startServer(api, machine.id, true);
        return {
          environmentId: repaired.environmentId,
          pairingCode: repaired.pairing?.code ?? null,
        };
      }
      return { environmentId: started.environmentId, pairingCode: started.pairing?.code ?? null };
    }),
  ).pipe(Effect.onError(() => Fiber.interrupt(checkoutFiber)));
  return {
    vmId: machine.id,
    environmentId: server.environmentId,
    httpBaseUrl: machine.url,
    pairingCode: server.pairingCode,
    workspaceRoot: repository.workspaceRoot,
    worktree,
    checkout: Fiber.join(checkoutFiber),
  } satisfies StartedMachine;
});

/** Stocks a code for a start that finds the spare without the holder's, and parks worktrees; waits for both. */
const warmSpareScript = `${stockPairingScript(PAIRING_LABEL)}
${parkWorktreesScript}
wait`;

/**
 * Keeps one spare from the current snapshot: server up, a code taken for the holder, worktrees
 * parked, then put to sleep so it costs little while it waits. A held spare whose code still
 * lasts is left asleep. Other spares are removed.
 */
const ensureSpare = Effect.fn("BoxdCloud.ensureSpare")(function* (input: {
  readonly api: BoxdApi;
  readonly snapshot: string;
  readonly held: ReadySpare | null;
  /** Spares this holder handed out that boxd may still list as spares. */
  readonly taken: ReadonlySet<string>;
}) {
  const { api, held } = input;
  const spares = (yield* api.listMachines([MACHINE_LABEL_FILTER])).filter(
    (machine) => isSpare(machine) && !input.taken.has(machine.id),
  );
  const fits = (machine: BoxdMachine) => machine.labels[SNAPSHOT_LABEL] === input.snapshot;
  const kept =
    spares.find((machine) => machine.id === held?.vmId && fits(machine)) ??
    spares.find(fits) ??
    null;
  yield* Effect.forEach(
    spares.filter((machine) => machine !== kept),
    (machine) => api.destroy(machine.id),
    { concurrency: "unbounded", discard: true },
  );
  const now = yield* Clock.currentTimeMillis;
  if (
    kept !== null &&
    held?.vmId === kept.id &&
    boxdMachineStateOf(kept.status) !== "stopped" &&
    held.codeExpiresAt - now > HAND_OUT_MARGIN_MS
  ) {
    return held;
  }
  let machine: BoxdMachine;
  if (kept === null) {
    machine = yield* api.createMachine({
      name: yield* randomName("t3"),
      labels: { ...MACHINE_LABELS, [ROLE_LABEL]: "spare", [SNAPSHOT_LABEL]: input.snapshot },
      snapshot: input.snapshot,
    });
  } else {
    if (boxdMachineStateOf(kept.status) === "stopped") yield* api.start(kept.id);
    machine = kept;
  }
  const started = yield* startServer(api, machine.id, true, SPARE_CODE_MINUTES);
  const pairing =
    started.pairing ?? (yield* vmFailure("T3 Code on the machine did not issue a pairing code."));
  yield* exec(api, machine.id, warmSpareScript, 300).pipe(Effect.ignore);
  yield* api.hibernate(machine.id).pipe(Effect.ignore);
  return {
    vmId: machine.id,
    environmentId: started.environmentId,
    httpBaseUrl: machine.url,
    pairingCode: pairing.code,
    snapshot: input.snapshot,
    codeExpiresAt: pairing.expiresAt,
  } satisfies ReadySpare;
});

/**
 * One holder's spare, kept ready in the background and remembered, so a start takes it
 * without asking boxd what is free.
 */
export const makeSpareKeeper = () => {
  let ready: ReadySpare | null = null;
  const taken = new Set<string>();
  let keeping = false;
  /** A keep asked for while one ran, run once that one ends since a start may have taken its spare. */
  let queued: Effect.Effect<void> | null = null;

  const keep = (api: BoxdApi, snapshot: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (keeping) {
        queued = keep(api, snapshot);
        return Effect.void;
      }
      keeping = true;
      return ensureSpare({ api, snapshot, held: ready, taken }).pipe(
        Effect.tap((spare) =>
          Effect.sync(() => {
            ready = taken.has(spare.vmId) ? null : spare;
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("boxd cloud could not keep a spare machine ready", { cause }),
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
    /** The ready spare for this snapshot, which no later start gets. */
    take: (snapshot: string) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const spare = ready;
        if (
          spare === null ||
          spare.snapshot !== snapshot ||
          spare.codeExpiresAt - now < HAND_OUT_MARGIN_MS
        ) {
          return null;
        }
        ready = null;
        taken.add(spare.vmId);
        return spare;
      }),
    /** Folds in boxd's list of the holder's machines. */
    reconcile: (machines: ReadonlyArray<BoxdMachine>) => {
      const byId = new Map(machines.map((machine) => [machine.id, machine]));
      const listed = ready === null ? undefined : byId.get(ready.vmId);
      if (listed === undefined || !isSpare(listed)) ready = null;
      for (const vmId of taken) {
        const machine = byId.get(vmId);
        if (machine === undefined || !isSpare(machine)) taken.delete(vmId);
      }
    },
  };
};

export type SpareKeeper = ReturnType<typeof makeSpareKeeper>;

/** The snapshot new machines start from: the newest ready one. */
export const startingSnapshot = (snapshots: ReadonlyArray<BoxdSnapshot>) => {
  let newest: BoxdSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.status !== "ready" || !isBoatCloudSnapshot(snapshot.name)) continue;
    if (newest === null || snapshot.updatedAt > newest.updatedAt) newest = snapshot;
  }
  return newest?.name ?? null;
};

/** The t3 build to save a snapshot of, or null when it is current or a setup is running. */
export const snapshotToBuild = Effect.fn("BoxdCloud.snapshotToBuild")(function* (
  api: BoxdApi,
  http: HttpClient.HttpClient,
) {
  const [version, snapshots, setups] = yield* Effect.all(
    [latestCliRelease(http), api.listSnapshots(), api.listMachines([SETUP_LABEL_FILTER])],
    { concurrency: "unbounded" },
  );
  if (setups.length > 0) return null;
  const name = snapshotNameOf(version, false);
  return snapshots.some((snapshot) => snapshot.name === name && snapshot.status !== "failed")
    ? null
    : version;
});

/** Until boxd saves the new version, the name reports the previous one as ready. */
const waitSnapshot = (api: BoxdApi, name: string, previousUpdatedAt: number) =>
  api.getSnapshot(name).pipe(
    Effect.flatMap((snapshot) => {
      if (snapshot?.status === "ready" && snapshot.updatedAt > previousUpdatedAt)
        return Effect.void;
      if (snapshot?.status === "failed")
        return Effect.fail(vmFailure("boxd could not save the snapshot."));
      return Effect.fail(vmFailure("boxd is still saving the snapshot.", "saving"));
    }),
    Effect.retry({
      schedule: Schedule.spaced(Duration.seconds(1)),
      times: 600,
      while: (error) => error.code === "saving",
    }),
  );

const cloneRepositories = (api: BoxdApi, vmId: string, remoteUrls: ReadonlyArray<string>) => {
  const repositories = [
    ...new Map(
      remoteUrls.flatMap((remoteUrl) => {
        const parsed = parseBoxdRepository(remoteUrl);
        return parsed ? [[parsed.key, parsed] as const] : [];
      }),
    ).values(),
  ];
  if (repositories.length === 0) return Effect.void;
  return exec(api, vmId, cloneRepositoriesScript(repositories), 300).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("boxd cloud could not clone repositories into the snapshot", { cause }),
    ),
    Effect.asVoid,
  );
};

/**
 * Builds the snapshot every machine starts from: the given t3 build installed as a service,
 * listening where boxd's proxy reaches it, the given repositories checked out, and no T3
 * state, so each copy gets its own environment id. Older snapshots are deleted once it is saved.
 */
export const buildSnapshot = Effect.fn("BoxdCloud.buildSnapshot")(function* (input: {
  readonly api: BoxdApi;
  readonly version: string;
  readonly repositories: ReadonlyArray<string>;
  readonly setStep: (step: BoatCloudSetupStep) => Effect.Effect<void>;
}) {
  const { api } = input;
  const name = snapshotNameOf(input.version, false);
  yield* input.setStep("create-vm");
  // A setup that died midway leaves its machine behind.
  for (const leftover of yield* api.listMachines([SETUP_LABEL_FILTER])) {
    yield* api.destroy(leftover.id);
  }
  const created = yield* api.createMachine({
    name: yield* randomName("t3-setup"),
    labels: SETUP_LABELS,
  });
  yield* Effect.gen(function* () {
    // Copies keep both, so each machine serves T3 at its URL from the start.
    yield* Effect.all(
      [api.setProxyPort(created.id, VM_T3_PORT), api.disableBotProtection(created.id)],
      { concurrency: 2, discard: true },
    );
    yield* input.setStep("install-server");
    yield* Effect.all(
      [
        exec(
          api,
          created.id,
          `${LISTEN_EVERYWHERE_SCRIPT}\n${installCliScript(input.version)}`,
          600,
        ).pipe(Effect.andThen(startServer(api, created.id, false))),
        cloneRepositories(api, created.id, input.repositories),
      ],
      { concurrency: 2, discard: true },
    );
    yield* input.setStep("save-snapshot");
    yield* exec(api, created.id, prepareSnapshotScript, 300);
    const previous = yield* api.getSnapshot(name);
    yield* api.createSnapshot(created.id, name);
    yield* waitSnapshot(api, name, previous?.updatedAt ?? 0);
  }).pipe(Effect.ensuring(api.destroy(created.id).pipe(Effect.ignore)));
  for (const older of yield* api.listSnapshots()) {
    if (older.name !== name && isBoatCloudSnapshot(older.name)) {
      yield* api.deleteSnapshot(older.name).pipe(Effect.ignore);
    }
  }
  return name;
});
