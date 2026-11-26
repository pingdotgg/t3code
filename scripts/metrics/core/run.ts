// The effectful half the benchmarks share: alternating A/B rounds, the machine watcher that
// records what competed with each run, and the process helpers they build on.
// @effect-diagnostics nodeBuiltinImport:off - NodeHttpServer takes a node:http server.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpServer } from "effect/http";

import { run } from "../../scenarios/shell.ts";
import { competingBetween, round, type MachineState } from "./report.ts";

export class MetricsError extends Schema.TaggedError<MetricsError>()("MetricsError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** What a command printed, or none when it is missing or failed. */
export const output = (program: string, args: ReadonlyArray<string>, cwd?: string) =>
  run(program, args, cwd === undefined ? {} : { cwd }).pipe(
    Effect.map(({ stdout }) => stdout.trim()),
    Effect.option,
  );
export const powershell = (script: string) =>
  output("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

/** Milliseconds on a monotonic clock, for intervals only. */
export const nowMs = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos) / 1e6);

export const httpServerOn = (port: number) =>
  NodeHttpServer.layer(() => NodeHttp.createServer(), { port, host: "127.0.0.1" });

/** Every process below `pid`. Windows needs none: taskkill /T stops the tree. */
export const descendantsOf = Effect.fn("serverMetrics.descendantsOf")(function* (pid: number) {
  const platform = yield* HostProcess.Platform;
  const children = new Map<number, number[]>();
  const add = (child: number, parent: number) =>
    children.set(parent, [...(children.get(parent) ?? []), child]);
  if (platform === "linux") {
    const fs = yield* FileSystem.FileSystem;
    for (const entry of yield* fs.readDirectory("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const stat = yield* fs
        .readFileString(`/proc/${entry}/stat`)
        .pipe(Effect.orElseSucceed(() => ""));
      const parent = Number(stat.split(") ")[1]?.split(" ")[1]);
      if (parent) add(Number(entry), parent);
    }
  } else if (platform === "darwin") {
    const table = yield* output("ps", ["-A", "-o", "pid=,ppid="]);
    if (Option.isNone(table)) return yield* new MetricsError({ message: "ps listed no processes" });
    for (const line of table.value.split("\n")) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (child && parent) add(child, parent);
    }
  } else return [];
  const found: number[] = [];
  const pending = [pid];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const child of children.get(next) ?? []) {
      found.push(child);
      pending.push(child);
    }
  }
  return found;
});

/** A free loopback port: bind 0, read it, let it go. */
export const freePort = Effect.scoped(
  Effect.gen(function* () {
    const context = yield* Layer.build(httpServerOn(0));
    const { address } = Context.get(context, HttpServer.HttpServer);
    return address._tag === "UnixPathAddress" ? 0 : address.port;
  }),
);

export const machineLoad = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") {
    return yield* powershell(
      "(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average",
    );
  }
  if (platform === "linux") {
    const fs = yield* FileSystem.FileSystem;
    const load = yield* fs.readFileString("/proc/loadavg").pipe(Effect.option);
    return Option.map(load, (text) => text.split(" ").slice(0, 3).join(" "));
  }
  return yield* output("sysctl", ["-n", "vm.loadavg"]);
}).pipe(
  Effect.map((load) =>
    Option.getOrNull(Option.map(load, (text) => text.replace(/[{}]/g, "").trim())),
  ),
);

/** Comm names of the processes that compete with a measured server on a developer's machine. */
const COMPETING = /^(node|node-MainThread|t3|claude|codex|vite|pnpm)/;

/**
 * CPU seconds of every node, T3, claude or codex process outside this script's own tree, keyed by
 * pid and start time so a reused pid is a new process. Linux only; elsewhere none, and the run
 * records only the load average.
 */
const competingCpuSeconds = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux") return Option.none<ReadonlyMap<string, number>>();
  const fs = yield* FileSystem.FileSystem;
  const self = Number(yield* fs.readLink("/proc/self"));
  const parents = new Map<number, number>();
  const cpu = new Map<number, { key: string; seconds: number }>();
  for (const entry of yield* fs.readDirectory("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = yield* fs
      .readFileString(`/proc/${entry}/stat`)
      .pipe(Effect.orElseSucceed(() => ""));
    const open = stat.indexOf(" (");
    const close = stat.lastIndexOf(") ");
    if (open < 0 || close < 0) continue;
    const fields = stat.slice(close + 2).split(" ");
    const pid = Number(entry);
    parents.set(pid, Number(fields[1]));
    if (COMPETING.test(stat.slice(open + 2, close))) {
      // Fields after the name start at the state, field 3: utime 14, stime 15, starttime 22.
      cpu.set(pid, {
        key: `${pid}:${fields[19]}`,
        seconds: (Number(fields[11]) + Number(fields[12])) / 100,
      });
    }
  }
  const ours = (pid: number) => {
    for (let at: number | undefined = pid; at !== undefined && at > 1; at = parents.get(at)) {
      if (at === self) return true;
    }
    return false;
  };
  return Option.some(
    new Map([...cpu].filter(([pid]) => !ours(pid)).map(([, { key, seconds }]) => [key, seconds])),
  );
}).pipe(Effect.orElseSucceed(() => Option.none<ReadonlyMap<string, number>>()));

/** How often the machine watcher reads competing CPU; a process that exits loses at most this. */
const MACHINE_SAMPLE_SECONDS = 10;

const load1 = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") return Option.none<number>();
  if (platform === "linux") {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString("/proc/loadavg").pipe(Effect.option);
    return Option.map(text, (value) => Number(value.split(" ")[0]));
  }
  const text = yield* output("sysctl", ["-n", "vm.loadavg"]);
  return Option.map(text, (value) => Number(value.replace(/[{}]/g, "").trim().split(/\s+/)[0]));
}).pipe(Effect.map(Option.filter(Number.isFinite)));

/**
 * Starts watching the machine for one run; the returned effect reads what competed with it: the
 * highest 1-minute load seen and the cores other T3, node and agent processes kept busy.
 */
export const watchMachine = Effect.gen(function* () {
  const startedAt = yield* nowMs;
  const loads: number[] = [];
  // Unknown (none) once any read fails, so a partial sum never passes for the whole run.
  let competing: Option.Option<number> = Option.some(0);
  let previous = yield* competingCpuSeconds;
  if (Option.isNone(previous)) competing = Option.none();
  // The periodic and final reads would otherwise interleave across the await below.
  const reading = yield* Semaphore.make(1);
  const read = Effect.gen(function* () {
    loads.push(...Option.toArray(yield* load1));
    if (Option.isNone(previous) || Option.isNone(competing)) return;
    const next = yield* competingCpuSeconds;
    if (Option.isNone(next)) {
      competing = Option.none();
      return;
    }
    competing = Option.some(competing.value + competingBetween(previous.value, next.value));
    previous = next;
  }).pipe(reading.withPermits(1));
  yield* read;
  // Reading through the run, not only at its ends, keeps a busy process that exits mid-run.
  yield* read.pipe(
    Effect.delay(Duration.seconds(MACHINE_SAMPLE_SECONDS)),
    Effect.forever,
    Effect.forkScoped,
  );
  return Effect.gen(function* () {
    yield* read;
    const elapsed = ((yield* nowMs) - startedAt) / 1_000;
    const machine: MachineState = {
      load1: loads.length ? round(Math.max(...loads), 2) : null,
      otherCpuCores:
        Option.isSome(competing) && elapsed > 0 ? round(competing.value / elapsed, 2) : null,
      minutes: round(elapsed / 60, 1),
    };
    return machine;
  });
});

/**
 * Runs A and B alternately, saving a side after each of its runs so a failure keeps the finished
 * runs. On a failure it reports how many runs of each side reached disk.
 */
export const runAbRounds = Effect.fn("serverMetrics.abRounds")(function* <
  A,
  S,
  E,
  R,
  ES,
  RS,
>(options: {
  readonly rounds: number;
  readonly outDir: string;
  readonly runSide: (side: 0 | 1) => Effect.Effect<A, E, R>;
  readonly save: (side: 0 | 1, runs: ReadonlyArray<A>) => Effect.Effect<S, ES, RS>;
}) {
  const runs: [A[], A[]] = [[], []];
  const persisted = [0, 0];
  const saveSide = Effect.fn("serverMetrics.abSave")(function* (side: 0 | 1) {
    const count = runs[side].length;
    const saved = yield* options.save(side, runs[side]);
    persisted[side] = count;
    return saved;
  });
  const saved: [S, S] = [yield* saveSide(0), yield* saveSide(1)];
  yield* Effect.gen(function* () {
    for (let round = 0; round < options.rounds; round++) {
      // A B, then B A, so a drift in machine load lands on both sides.
      for (const side of round % 2 === 0 ? ([0, 1] as const) : ([1, 0] as const)) {
        yield* Console.error(`round ${round + 1}/${options.rounds}: ${side === 0 ? "A" : "B"}`);
        runs[side].push(yield* options.runSide(side));
        saved[side] = yield* saveSide(side);
      }
    }
  }).pipe(
    Effect.onError(() =>
      Console.error(
        `ab stopped early; ${options.outDir} keeps ${persisted[0]} A and ${persisted[1]} B runs`,
      ),
    ),
  );
  return saved;
});
