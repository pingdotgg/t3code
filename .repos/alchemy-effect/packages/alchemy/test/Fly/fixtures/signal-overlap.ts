import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import type { ScratchStack } from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  Witness as ProcessDeathWitness,
  census,
  evidencePaths,
  identity,
  machine,
  nowSeconds,
  persistedRow,
} from "./process-death.ts";
import type { TransportEvent } from "./transport.ts";

export const signalOverlapFile = "test/Fly/BlueGreen.test.ts";
export const cases = [
  { name: "sigint-create", signal: "SIGINT", phase: "create" },
  { name: "sigint-promotion", signal: "SIGINT", phase: "promotion" },
  { name: "sigint-overlap", signal: "SIGINT", phase: "overlap" },
  { name: "sigint-retirement", signal: "SIGINT", phase: "retirement" },
  { name: "sigkill-overlap", signal: "SIGKILL", phase: "overlap" },
] as const;
export type SignalCase = (typeof cases)[number];

const Boundary = Schema.Struct({
  sequence: Schema.Number,
  method: Schema.String,
  path: Schema.String,
  status: Schema.Number,
  machineId: Schema.String,
});

export const Witness = Schema.Struct({
  ...ProcessDeathWitness.fields,
  signal: Schema.Literals(["SIGINT", "SIGKILL"]),
  phase: Schema.Literals(["create", "promotion", "overlap", "retirement"]),
  case: Schema.String,
  barrier: Boundary,
  // The subsequent routing read proves the provider consumed the uncordon response.
  returnedUncordon: Schema.optional(Boundary),
});
export type Witness = typeof Witness.Type;

const LeaseObservation = Schema.Struct({
  machineId: Schema.String,
  present: Schema.Boolean,
  expiresAt: Schema.Number,
  at: Schema.Number,
});

export const Finalized = Schema.Struct({
  pid: Schema.Number,
  case: Schema.String,
  witnessRecordedAt: Schema.Number,
  interruptedOnly: Schema.Boolean,
  at: Schema.Number,
  releases: Schema.Array(Boundary),
  leases: Schema.Array(LeaseObservation),
});

export const RunnerInterrupted = Schema.Struct({
  pid: Schema.Number,
  case: Schema.String,
  signal: Schema.Literal("SIGINT"),
  witnessRecordedAt: Schema.Number,
  at: Schema.Number,
  deployFinalized: Schema.Boolean,
});

export const pathsFor = (stack: ScratchStack) =>
  Effect.gen(function* () {
    const paths = yield* evidencePaths(stack);
    const path = yield* Path.Path;
    return {
      ...paths,
      runnerInterrupted: path.join(paths.directory, "runner-interrupted.json"),
      blocked: path.join(paths.directory, "interruption-limit.json"),
    };
  });

export const readEvidence = <S extends Schema.Top>(file: string, schema: S) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(schema), {
          onExcessProperty: "error",
        }),
      ),
      Effect.mapError(
        () =>
          new Error("Missing or invalid signal evidence; preserve the attempt"),
      ),
    );
  });

export const assertSingleRunner = Effect.gen(function* () {
  const args = yield* Effect.sync(() => process.argv.slice(2));
  const focused =
    args[0] === "--exclude" && args[1] === "test/Railway"
      ? args.slice(2)
      : args;
  expect(focused).toEqual([
    signalOverlapFile,
    "-t",
    " > process signals and overlap > ",
    "--profile",
    "testing",
    "--retry",
    "0",
    "--concurrency",
    "1",
    "--sequential",
    "--timeout",
    "750000",
  ]);
  expect(process.env.FLY_SIGNAL_OVERLAP_ONLY_RUNNER).toBe("1");
  expect(process.env.FLY_PROCESS_DEATH_CASE).toBeUndefined();
  expect(process.env.FLY_PROCESS_DEATH_MODE).toBeUndefined();
  expect(process.env.ALCHEMY_PROFILE).toBe("testing");
  expect(process.env.ALCHEMY_TEST_DEV).toBe("0");
  expect(process.env.ALCHEMY_DEV).toBe("0");
  expect(process.env.ALCHEMY_TEST_STAGE).toBe("test_fly_signal_overlap");
  expect(process.env.FAST).toBeUndefined();
  expect(process.versions.bun).toBeDefined();
  const fs = yield* FileSystem.FileSystem;
  for (const file of [
    signalOverlapFile,
    "test/Fly/fixtures/signal-overlap.ts",
    "test/Fly/fixtures/process-death.ts",
    "test/Fly/fixtures/transport.ts",
  ]) {
    const source = yield* fs.readFileString(file);
    expect(source).not.toMatch(
      /(?:from\s+|import\s*(?:\(\s*)?|require\s*\()\s*["'](?:node:)?child_process["']/,
    );
    expect(source).not.toMatch(
      /\b(?:Bun|Deno)\s*\.\s*(?:spawn|spawnSync|Command)\s*\(/,
    );
    expect(source).not.toMatch(
      /from\s+["'][^"']*(?:ChildProcess|CommandExecutor)[^"']*["']/,
    );
  }
});

export const successful = (event: TransportEvent) =>
  event.status !== undefined && event.status >= 200 && event.status < 300;

export const boundary = (event: TransportEvent) => {
  expect(successful(event)).toBe(true);
  expect(event.machineId).toBeDefined();
  return {
    sequence: event.sequence,
    method: event.method,
    path: event.path,
    status: event.status!,
    machineId: event.machineId!,
  };
};

export const firstReturnedUncordon = (
  events: readonly TransportEvent[],
  appName: string,
) =>
  events.find(
    (event) =>
      event.stage === "forwarded" &&
      successful(event) &&
      event.method === "POST" &&
      event.path.startsWith(`/v1/apps/${appName}/machines/`) &&
      event.path.endsWith("/uncordon"),
  );

export const matches = (
  phase: SignalCase["phase"],
  appName: string,
  predecessorId: string,
  events: readonly TransportEvent[],
  event: TransportEvent,
) => {
  const base = `/v1/apps/${appName}/machines`;
  if (phase === "create") return event.method === "POST" && event.path === base;
  if (phase === "promotion")
    return (
      event.method === "POST" &&
      event.path.startsWith(`${base}/`) &&
      event.path.endsWith("/uncordon")
    );
  if (phase === "retirement")
    return (
      event.method === "DELETE" && event.path === `${base}/${predecessorId}`
    );
  const returned = firstReturnedUncordon(events, appName);
  return (
    returned !== undefined &&
    returned.machineId !== predecessorId &&
    event.sequence > returned.sequence &&
    event.method === "GET" &&
    event.path === `${base}/${returned.machineId}`
  );
};

export const assertBoundary = (witness: Witness) =>
  Effect.sync(() => {
    const { barrier, returnedUncordon } = witness;
    expect(barrier.sequence).toBeGreaterThan(0);
    expect(barrier.status).toBeGreaterThanOrEqual(200);
    expect(barrier.status).toBeLessThan(300);
    expect(barrier.machineId).toBe(
      witness.phase === "retirement"
        ? witness.predecessor.id
        : witness.candidate.id,
    );
    if (witness.phase === "overlap") {
      expect(returnedUncordon).toBeDefined();
      expect(returnedUncordon!.method).toBe("POST");
      expect(returnedUncordon!.path).toBe(
        `/v1/apps/${witness.appName}/machines/${witness.candidate.id}/uncordon`,
      );
      expect(returnedUncordon!.machineId).toBe(witness.candidate.id);
      expect(returnedUncordon!.status).toBeGreaterThanOrEqual(200);
      expect(returnedUncordon!.status).toBeLessThan(300);
      expect(returnedUncordon!.sequence).toBeGreaterThan(0);
      expect(barrier.sequence).toBeGreaterThan(returnedUncordon!.sequence);
    } else expect(returnedUncordon).toBeUndefined();
    expect(
      matches(
        witness.phase,
        witness.appName,
        witness.predecessor.id,
        returnedUncordon ? [{ ...returnedUncordon, stage: "forwarded" }] : [],
        { ...barrier, stage: "held" },
      ),
    ).toBe(true);
  });

export const assertInventory = (stack: ScratchStack, witness: Witness) =>
  Effect.gen(function* () {
    const live = yield* census(witness.appName);
    expect(live.map((value) => value.id).sort()).toEqual(
      (witness.phase === "retirement"
        ? [witness.candidate.id]
        : [witness.predecessor.id, witness.candidate.id]
      ).sort(),
    );
    const candidate = yield* machine(witness.appName, witness.candidate.id);
    expect(yield* identity(candidate, stack)).toEqual(witness.candidate);
    expect(candidate.config?.env?.VERSION).toBe("two");
    expect(candidate.cordoned).toBe(witness.phase === "create");
    expect(witness.candidate.phase).toBe(
      witness.phase === "create"
        ? "candidate"
        : witness.phase === "retirement"
          ? "active"
          : "promoting",
    );
    if (witness.phase !== "retirement") {
      const predecessor = yield* machine(
        witness.appName,
        witness.predecessor.id,
      );
      expect(yield* identity(predecessor, stack)).toEqual(witness.predecessor);
      expect(predecessor.cordoned).toBe(false);
      expect(predecessor.state).toBe("started");
      expect(predecessor.config?.env?.VERSION).toBe("one");
    }
  });

// Only presence and timestamps escape the SDK; nonce and transport headers never do.
export const observeLease = (appName: string, machineId: string) =>
  machines.getMachineLease({ app_name: appName, machine_id: machineId }).pipe(
    Retry.none,
    Effect.map((value) => ({
      present: !!value.data?.nonce,
      expiresAt: value.data?.expires_at ?? 0,
    })),
    Effect.catchTag("NotFound", () =>
      Effect.succeed({ present: false, expiresAt: 0 }),
    ),
    Effect.timeout("10 seconds"),
    Effect.mapError(
      (error) => new Error(`Signal lease observation failed (${error._tag})`),
    ),
    Effect.flatMap((value) =>
      nowSeconds.pipe(Effect.map((at) => ({ machineId, ...value, at }))),
    ),
  );

export const observeLeases = (witness: Witness) =>
  Effect.forEach(
    witness.leases,
    (held) => observeLease(witness.appName, held.machineId),
    { concurrency: 2 },
  );

export const observeExpiry = (witness: Witness) =>
  Effect.gen(function* () {
    expect(witness.signal).toBe("SIGKILL");
    expect(witness.leases.length).toBeGreaterThan(0);
    const initial = yield* observeLeases(witness);
    for (const [index, value] of initial.entries()) {
      expect(value.present).toBe(true);
      expect(value.expiresAt).toBeGreaterThan(value.at);
      expect(value.expiresAt).toBeGreaterThanOrEqual(
        witness.leases[index]!.expiresAt,
      );
      expect(value.expiresAt).toBeLessThanOrEqual(witness.recordedAt + 130);
    }
    const samples: (typeof LeaseObservation.Type)[] = [];
    const expired = yield* Effect.forEach(
      initial,
      (held) =>
        Effect.gen(function* () {
          const value = yield* observeLease(witness.appName, held.machineId);
          yield* Effect.sync(() => samples.push(value));
          if (value.present) expect(value.expiresAt).toBe(held.expiresAt);
          else expect(value.at).toBeGreaterThanOrEqual(held.expiresAt);
          return !value.present;
        }),
      { concurrency: 2 },
    ).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        times: 65,
        until: (all) => all.every(Boolean),
      }),
      Effect.timeout("230 seconds"),
    );
    expect(expired.every(Boolean)).toBe(true);
    for (const held of initial) {
      const surviving = yield* machine(witness.appName, held.machineId);
      expect(surviving.state).not.toBe("destroyed");
    }
    return { initial, samples };
  });

export const assertReleased = (
  witness: Witness,
  finalized: typeof Finalized.Type,
) =>
  Effect.gen(function* () {
    expect(witness.signal).toBe("SIGINT");
    expect(witness.leases.length).toBeGreaterThan(0);
    expect(finalized.pid).toBe(witness.pid);
    expect(finalized.case).toBe(witness.case);
    expect(finalized.witnessRecordedAt).toBe(witness.recordedAt);
    expect(finalized.interruptedOnly).toBe(true);
    expect(finalized.at).toBeGreaterThanOrEqual(witness.recordedAt);
    expect(finalized.leases.map((value) => value.machineId).sort()).toEqual(
      witness.leases.map((value) => value.machineId).sort(),
    );
    for (const held of witness.leases) {
      const observed = finalized.leases.find(
        (value) => value.machineId === held.machineId,
      )!;
      expect(observed.present).toBe(false);
      expect(observed.at).toBeGreaterThanOrEqual(witness.recordedAt);
      expect(observed.at).toBeLessThan(held.expiresAt);
      expect(finalized.at).toBeLessThan(held.expiresAt);
      const release = finalized.releases.find(
        (event) =>
          event.machineId === held.machineId &&
          event.status >= 200 &&
          event.status < 300,
      );
      expect(release).toBeDefined();
      expect(release!.method).toBe("DELETE");
      expect(release!.path).toBe(
        `/v1/apps/${witness.appName}/machines/${held.machineId}/lease`,
      );
      expect(release!.sequence).toBeGreaterThan(witness.barrier.sequence);
      // A deleted Machine cannot masquerade as a released lease.
      const surviving = yield* machine(witness.appName, held.machineId);
      expect(surviving.state).not.toBe("destroyed");
    }
    const current = yield* observeLeases(witness);
    expect(current.every((value) => !value.present)).toBe(true);
    return { finalized, current };
  });

export const assertConverged = (
  stack: ScratchStack,
  witness: Witness,
  ids: string[],
) =>
  Effect.gen(function* () {
    expect(ids).toEqual([witness.candidate.id]);
    const live = yield* census(witness.appName);
    expect(live.map((value) => value.id)).toEqual(ids);
    const current = yield* machine(witness.appName, witness.candidate.id).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        times: 20,
        until: (value) =>
          value.state === "started" &&
          value.cordoned === false &&
          value.checks?.some(
            (check) => check.name === "ready" && check.status === "passing",
          ) === true,
      }),
      Effect.timeout("60 seconds"),
    );
    expect(yield* identity(current, stack)).toEqual({
      ...witness.candidate,
      phase: "active",
    });
    expect(current.state).toBe("started");
    expect(current.cordoned).toBe(false);
    expect(current.config?.env?.VERSION).toBe("two");
    const ready =
      current.checks?.filter((check) => check.name === "ready") ?? [];
    expect(ready.length).toBeGreaterThan(0);
    expect(ready.every((check) => check.status === "passing")).toBe(true);
    expect(current.instance_id).toBeDefined();
    expect(current.config?.metadata?.["alchemy.checked-instance"]).toBe(
      current.instance_id,
    );
    expect(current.config?.metadata?.["alchemy.predecessors"]).toBe(
      witness.predecessor.id,
    );
    expect(
      current.config?.metadata?.["alchemy.image"]?.endsWith(
        `@${witness.candidate.digest}`,
      ),
    ).toBe(true);
    const row = yield* persistedRow(stack, witness.row.fqn);
    expect(row.instanceId).toBe(witness.row.instanceId);
    expect(["created", "updated"]).toContain(row.status);
  });
