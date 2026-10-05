import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Fly from "@/Fly";
import { State } from "@/State/State";
import type { ScratchStack } from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type { TransportEvent } from "./transport.ts";

export const processDeathFile = "test/Fly/BlueGreen.test.ts";
export const phases = ["create", "promotion", "retirement"] as const;
export type Phase = (typeof phases)[number];

const Identity = Schema.Struct({
  id: Schema.String,
  generation: Schema.String,
  workload: Schema.String,
  sequence: Schema.String,
  digest: Schema.String,
  instance: Schema.String,
  fqn: Schema.String,
  phase: Schema.String,
});

export const Witness = Schema.Struct({
  version: Schema.Literal(1),
  signal: Schema.Literal("SIGKILL"),
  phase: Schema.Literals(phases),
  pid: Schema.Number,
  cwd: Schema.String,
  stack: Schema.String,
  stage: Schema.String,
  appName: Schema.String,
  recordedAt: Schema.Number,
  predecessor: Identity,
  candidate: Identity,
  barrier: Schema.Struct({
    sequence: Schema.Number,
    method: Schema.String,
    path: Schema.String,
    status: Schema.Number,
    machineId: Schema.String,
  }),
  leases: Schema.Array(
    Schema.Struct({
      machineId: Schema.String,
      expiresAt: Schema.Number,
    }),
  ),
  row: Schema.Struct({
    fqn: Schema.String,
    instanceId: Schema.String,
    status: Schema.String,
  }),
});
export type Witness = typeof Witness.Type;

// SDK transport failures can retain headers; never persist or print those objects.
const read = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Retry.none,
    Effect.timeout("10 seconds"),
    Effect.mapError(
      (error) =>
        new Error(`Process-death SDK observation failed (${error._tag})`),
    ),
  );

export const nowSeconds = Effect.sync(() => Math.floor(Date.now() / 1000));

export const evidencePaths = (stack: ScratchStack) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const cwd = yield* Effect.sync(() => process.cwd());
    const directory = path.join(
      cwd,
      ".alchemy",
      "fly-process-death",
      stack.name,
      stack.stage,
    );
    return {
      cwd,
      directory,
      witness: path.join(directory, "witness.json"),
      finalized: path.join(directory, "finalized.json"),
      recovered: path.join(directory, "recovered.json"),
    };
  });

/** File and containing directory are synced before the caller can signal itself. */
export const writeEvidence = (file: string, value: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.dirname(file);
    yield* fs.makeDirectory(directory, { recursive: true });
    const temporary = `${file}.tmp`;
    const bytes = yield* Effect.sync(() =>
      new TextEncoder().encode(JSON.stringify(value)),
    );
    yield* Effect.gen(function* () {
      const handle = yield* fs.open(temporary, { flag: "w", mode: 0o600 });
      yield* handle.writeAll(bytes);
      yield* handle.sync;
    }).pipe(Effect.scoped);
    yield* fs.rename(temporary, file);
    yield* Effect.gen(function* () {
      const handle = yield* fs.open(directory, { flag: "r" });
      yield* handle.sync;
    }).pipe(Effect.scoped);
  });

export const readWitness = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Witness), {
          onExcessProperty: "error",
        }),
      ),
      Effect.mapError(
        () =>
          new Error(
            "Missing or invalid process-death witness; preserve state and inspect the crash leg",
          ),
      ),
    );
  });

export const assertSingleRunner = Effect.gen(function* () {
  const args = yield* Effect.sync(() => process.argv.slice(2));
  // pnpm test adds this exclusion before the explicitly focused file.
  const focused =
    args[0] === "--exclude" && args[1] === "test/Railway"
      ? args.slice(2)
      : args;
  expect(focused).toEqual([
    processDeathFile,
    "-t",
    " > process death > ",
    "--profile",
    "testing",
    "--retry",
    "0",
    "--concurrency",
    "1",
    "--sequential",
    "--timeout",
    "500000",
  ]);
  expect(process.env.FLY_PROCESS_DEATH_ONLY_RUNNER).toBe("1");
  expect(process.env.ALCHEMY_PROFILE).toBe("testing");
  expect(process.env.ALCHEMY_TEST_DEV).toBe("0");
  expect(process.env.ALCHEMY_DEV).toBe("0");
  const fs = yield* FileSystem.FileSystem;
  for (const file of [
    processDeathFile,
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

export const deploy = (stack: ScratchStack, version: "one" | "two") =>
  stack.deploy(
    Effect.gen(function* () {
      const app = yield* Fly.App("Site");
      return yield* Fly.Machine("Worker", {
        app,
        region: "iad",
        count: 1,
        image: "nginx:alpine",
        guest: { cpus: 1, memoryMb: 256 },
        env: { VERSION: version },
        checks: {
          ready: {
            type: "http",
            port: 80,
            path: "/",
            interval: "2s",
            timeout: "1s",
          },
        },
        deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
        shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
      });
    }),
  );

export const census = (appName: string) =>
  read(machines.listMachines({ app_name: appName })).pipe(
    Effect.map((all) => all.filter((machine) => machine.state !== "destroyed")),
  );

export const machine = (appName: string, machineId: string) =>
  read(
    machines.getMachine({
      app_name: appName,
      machine_id: machineId,
    }),
  );

export const identity = (value: machines.Machine, stack: ScratchStack) =>
  Effect.sync(() => {
    const metadata = value.config?.metadata ?? {};
    expect(metadata["alchemy.stack"]).toBe(stack.name);
    expect(metadata["alchemy.stage"]).toBe(stack.stage);
    expect(metadata["alchemy.id"]).toBe("Worker");
    expect(metadata["alchemy.type"]).toBe("Fly.Machine");
    expect(metadata["alchemy.count"]).toBe("1");
    expect(metadata["alchemy.replica"]).toBe("0");
    expect(metadata["alchemy.deployment-protocol"]).toBe("1");
    const result = {
      id: value.id!,
      generation: metadata["alchemy.generation"]!,
      workload: metadata["alchemy.workload"]!,
      sequence: metadata["alchemy.sequence"]!,
      digest: value.image_ref?.digest!,
      instance: metadata["alchemy.instance"]!,
      fqn: metadata["alchemy.fqn"]!,
      phase: metadata["alchemy.phase"]!,
    };
    for (const value of Object.values(result)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
    expect(result.digest).toMatch(/^sha256:/);
    return result;
  });

export const persistedRow = (stack: ScratchStack, fqn: string) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    expect(state.id).toBe("local");
    const row = yield* state.get({
      stack: stack.name,
      stage: stack.stage,
      fqn,
    });
    if (!row || row.kind === "action") {
      return yield* Effect.fail(
        new Error(
          "Expected the original durable resource row; refusing to recreate evidence",
        ),
      );
    }
    return { fqn: row.fqn, instanceId: row.instanceId, status: row.status };
  }).pipe(Effect.provide(stack.state));

export const matchesBarrier = (
  phase: Phase,
  appName: string,
  predecessorId: string,
  event: TransportEvent,
) => {
  const base = `/v1/apps/${appName}/machines`;
  return phase === "create"
    ? event.method === "POST" && event.path === base
    : phase === "promotion"
      ? event.method === "POST" &&
        event.path.startsWith(`${base}/`) &&
        event.path.endsWith("/uncordon")
      : event.method === "DELETE" && event.path === `${base}/${predecessorId}`;
};

const lease = (appName: string, machineId: string) =>
  read(
    machines
      .getMachineLease({
        app_name: appName,
        machine_id: machineId,
      })
      .pipe(
        Effect.map((value) => ({
          present: !!value.data?.nonce,
          expiresAt: value.data?.expires_at ?? 0,
        })),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({ present: false, expiresAt: 0 }),
        ),
      ),
  );

export const heldLeases = (appName: string, ids: string[]) =>
  Effect.gen(function* () {
    const leases = yield* Effect.forEach(
      ids,
      (machineId) =>
        lease(appName, machineId).pipe(
          Effect.map((value) => ({ machineId, ...value })),
        ),
      { concurrency: 2 },
    );
    const now = yield* nowSeconds;
    const held = leases.filter((value) => value.present);
    expect(held.length).toBeGreaterThan(0);
    for (const value of held) {
      expect(value.expiresAt).toBeGreaterThan(now + 20);
      expect(value.expiresAt).toBeLessThanOrEqual(now + 130);
    }
    return held.map(({ machineId, expiresAt }) => ({ machineId, expiresAt }));
  });

/** Observe live authority in the new process, then native expiry without release/acquire. */
export const observeLeaseExpiry = (witness: Witness) =>
  Effect.gen(function* () {
    expect(witness.leases.length).toBeGreaterThan(0);
    const initial = yield* Effect.forEach(
      witness.leases,
      (held) =>
        Effect.gen(function* () {
          const observed = yield* lease(witness.appName, held.machineId);
          const now = yield* nowSeconds;
          expect(observed.present).toBe(true);
          expect(observed.expiresAt).toBeGreaterThan(now);
          expect(observed.expiresAt).toBeGreaterThanOrEqual(held.expiresAt);
          expect(observed.expiresAt).toBeLessThanOrEqual(
            witness.recordedAt + 130,
          );
          return { machineId: held.machineId, expiresAt: observed.expiresAt };
        }),
      { concurrency: 2 },
    );
    const samples: {
      machineId: string;
      present: boolean;
      expiresAt: number;
      at: number;
    }[] = [];
    const expired = yield* Effect.forEach(
      initial,
      (held) =>
        Effect.gen(function* () {
          const value = yield* lease(witness.appName, held.machineId);
          const at = yield* nowSeconds;
          yield* Effect.sync(() =>
            samples.push({ machineId: held.machineId, ...value, at }),
          );
          if (value.present) expect(value.expiresAt).toBe(held.expiresAt);
          if (!value.present) expect(at).toBeGreaterThanOrEqual(held.expiresAt);
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
    // A deleted Machine is not evidence of lease expiration.
    for (const held of initial) {
      const surviving = yield* machine(witness.appName, held.machineId);
      expect(surviving.state).not.toBe("destroyed");
    }
    return { initial, samples };
  });

export const assertBarrierInventory = (stack: ScratchStack, witness: Witness) =>
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
        : witness.phase === "promotion"
          ? "promoting"
          : "active",
    );
    if (witness.phase !== "retirement") {
      const predecessor = yield* machine(
        witness.appName,
        witness.predecessor.id,
      );
      expect(yield* identity(predecessor, stack)).toEqual(witness.predecessor);
      expect(predecessor.cordoned).toBe(false);
    }
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
    expect(current.config?.metadata?.["alchemy.checked-instance"]).toBe(
      current.instance_id,
    );
    expect(current.instance_id).toBeDefined();
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

export const assertClean = (stack: ScratchStack, appName: string) =>
  Effect.gen(function* () {
    const gone = yield* read(
      machines.getApp({ app_name: appName }).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      ),
    ).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        times: 8,
        until: Boolean,
      }),
    );
    expect(gone).toBe(true);
    const remaining = yield* read(
      machines
        .listMachines({ app_name: appName })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed([]))),
    );
    expect(
      remaining.filter((value) => value.state !== "destroyed"),
    ).toHaveLength(0);
    const rows = yield* Effect.gen(function* () {
      const state = yield* yield* State;
      return yield* state.list({ stack: stack.name, stage: stack.stage });
    }).pipe(Effect.provide(stack.state));
    expect(rows).toHaveLength(0);
  });
