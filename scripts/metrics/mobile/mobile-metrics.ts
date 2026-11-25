#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalJsonInEffect:off - leases go through mobile-behavior's Promise-based pool helpers.
/**
 * Measures the mobile app like client-metrics measures the web one: thread switches, tabs, a pull
 * request, typing and scrolling on a Simlock iOS simulator, through mobile:behavior's server,
 * Metro and probe. See docs/internals/16_performance-regressions.md#mobile-switch-metrics.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcessSpawner } from "effect/process";

import {
  leaseAndInstall,
  openPool,
  releaseOnCrash,
  renewWhileRunning,
  type PoolAccess,
} from "../../mobile-behavior/pool.ts";
import { reachableHost, startSession, type Build } from "../../mobile-behavior/session.ts";
import type { Device as PoolDevice } from "../../mobile-e2e/device.ts";
import { CASE_NAMES, CASES, type CaseContext, type CaseName, type Fixtures } from "./cases.ts";
import {
  flatten,
  MobileMetrics,
  PROBE_KEYS,
  summaryTable,
  WORKLOAD_KEYS,
  workloadDifferences,
  type Memory,
  type Run,
  type SoakSample,
  type Step,
} from "./report.ts";
import { run } from "../../scenarios/shell.ts";
import { DIFF_FILES, pullRequestDetail, sourceFile } from "../core/fixture.ts";
import { serveFakeGitHub, type FakeGitHub } from "../core/forge.ts";
import { compareSeries, Floors, noiseOfSeries } from "../core/report.ts";
import { machineLoad, MetricsError, output, runAbRounds } from "../core/run.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../../..");
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const decodeMetrics = Schema.decodeUnknownEffect(Schema.fromJsonString(MobileMetrics));
const encodeMetrics = Schema.encodeEffect(fromJsonStringPretty(MobileMetrics));
const decodeFloors = Schema.decodeUnknownEffect(Schema.fromJsonString(Floors));
const encodeFloors = Schema.encodeEffect(fromJsonStringPretty(Floors));

const log = (message: string) => Console.error(`[mobile-metrics] ${message}`);

/** The scratch repository on a branch changing many files, with an open PR on the fake GitHub. */
const prepareBenchProject = (forge: FakeGitHub) =>
  Effect.fn("mobileMetrics.prepareProject")(function* (workspace: string) {
    const fs = yield* FileSystem.FileSystem;
    const git = (args: ReadonlyArray<string>) => run("git", args, { cwd: workspace });
    const author = ["-c", "user.email=bench@t3.codes", "-c", "user.name=bench"];
    yield* git(["branch", "-M", "main"]);
    yield* fs.makeDirectory(NodePath.join(workspace, "src"), { recursive: true });
    for (let index = 0; index < DIFF_FILES; index++)
      yield* fs.writeFileString(
        NodePath.join(workspace, `src/module${index}.ts`),
        sourceFile(index, "before"),
      );
    yield* git(["add", "."]);
    yield* git([...author, "commit", "-qm", "modules"]);
    // The feature branch commits these, so its diff against main is the pull request's weight.
    for (let index = 0; index < DIFF_FILES; index++)
      yield* fs.writeFileString(
        NodePath.join(workspace, `src/module${index}.ts`),
        sourceFile(index, "after"),
      );
    yield* forge.setupProject(workspace);
  });

/** The app process's memory from agent-device, in MB; its field differs by platform. */
const processMemory = Effect.fn("mobileMetrics.processMemory")(function* (
  device: CaseContext["device"],
  raw: string,
) {
  const out = yield* device.run(["perf", "memory", "sample", "--json"]).pipe(Effect.option);
  if (Option.isNone(out)) return null;
  yield* Effect.promise(() => NodeFSP.writeFile(raw, out.value));
  const memory = (
    JSON.parse(out.value) as { data?: { metrics?: { memory?: Record<string, unknown> } } }
  ).data?.metrics?.memory;
  if (!memory || memory.available === false) return null;
  const field =
    ["physFootprintKb", "footprintKb", "totalPssKb", "residentMemoryKb", "totalRssKb"].find(
      (key) => typeof memory[key] === "number",
    ) ?? Object.keys(memory).find((key) => /Kb$/.test(key) && typeof memory[key] === "number");
  return field ? Math.round(((memory[field] as number) / 1024) * 10) / 10 : null;
});

const memorySample = Effect.fn("mobileMetrics.memory")(function* (
  device: CaseContext["device"],
  label: string,
  out: string,
) {
  const heap = yield* device.evaluate("__t3Behavior.heap()").pipe(
    Effect.map((value) => {
      // Older probes return the byte count itself.
      if (typeof value === "number") return value;
      const parsed = JSON.parse(String(value)) as { bytes: number | null };
      return parsed.bytes;
    }),
    Effect.orElseSucceed(() => null),
  );
  const sample: Memory = {
    label,
    heapMB: typeof heap === "number" ? Math.round((heap / 1_048_576) * 10) / 10 : null,
    processMB: yield* processMemory(device, NodePath.join(out, `memory-${label}.json`)),
  };
  return sample;
});

interface MeasureOptions {
  readonly checkout: string;
  readonly out: string;
  readonly access: PoolAccess;
  readonly deviceSession: string;
  readonly cases: ReadonlyArray<CaseName>;
  readonly rounds: number;
  readonly longTurns: number;
  readonly renders: boolean;
  readonly host: string;
  readonly soak: number;
  readonly build: Build;
}

/** The cases `--soak` repeats: thread switches, the flow whose memory matters most. */
const SOAK_CASES = ["switch-short", "switch-long"] as const satisfies ReadonlyArray<CaseName>;

/** One app launch on a checkout's Metro: seed, pair, run every case `rounds` times. */
const measureOnce = Effect.fn("mobileMetrics.measureOnce")(function* (options: MeasureOptions) {
  yield* Effect.promise(() => NodeFSP.mkdir(options.out, { recursive: true }));
  const forge = yield* serveFakeGitHub({ detail: pullRequestDetail() });
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const session = yield* startSession({
    out: options.out,
    host: options.host,
    agentDevice: options.access.pool.agentDevice,
    deviceConfig: options.access.config,
    deviceSession: options.deviceSession,
    device: "",
    deviceName: "",
    // A leased simulator is wiped on release; anything saved on it is a previous run's.
    forgetOtherEnvironments: true,
    longTurns: options.longTurns,
    checkout: options.checkout,
    metroEnv: options.renders ? { EXPO_PUBLIC_T3_RENDER_COUNTER: "1" } : {},
    build: options.build,
    environment: {
      serverEnv: forge.env,
      prepareWorkspace: (workspace) =>
        prepareBenchProject(forge)(workspace).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
    },
  });
  const { env, device } = session;
  const short = yield* env.launch("Bench short", "Hi. [[eval:reply]]");
  yield* env.settled(short);
  // A side chat people open holds a message; an empty one shows a placeholder, not a timeline.
  const sideChat = yield* env.forkSideChat(short, "Bench side chat");
  yield* env.send(sideChat, "Hi from the side. [[eval:reply]]");
  yield* env.settled(sideChat);
  const fixtures: Fixtures = {
    sideChat: { id: sideChat, title: "Bench side chat" },
    short: { id: short, title: "Bench short" },
    long: { id: session.longThread, title: session.longTitle },
  };
  const supported = yield* device
    .evaluate("typeof __t3Behavior.perfStart")
    .pipe(Effect.orElseSucceed(() => "undefined"));
  if (supported !== "function") {
    const reason = "this checkout's behavior probe has no perf window";
    return {
      steps: [],
      memory: [],
      skipped: options.cases.map((name) => ({ case: name, reason })),
    } satisfies Run;
  }
  yield* Effect.sleep("3 seconds");
  const memory: Memory[] = [yield* memorySample(device, "launch", options.out)];
  const steps: Step[] = [];
  const skipped: Array<{ case: string; reason: string }> = [];
  const visited = new Set<string>();
  for (let round = 1; round <= options.rounds; round++) {
    for (const name of options.cases) {
      const ctx: CaseContext = { session, device, fixtures, round, visited };
      const result = yield* CASES[name](ctx).pipe(
        Effect.map((measured) => ({ measured })),
        Effect.catch((error) => Effect.succeed({ error: error.message })),
      );
      if ("error" in result) {
        yield* log(`${name} round ${round}: ${result.error}`);
        // What was on screen, so a selector that missed can be fixed from the labels.
        const labels = yield* device.nodes.pipe(
          Effect.map((nodes) =>
            nodes.flatMap((node) =>
              node.label ? [`${node.kind ?? node.type}: ${node.label}`] : [],
            ),
          ),
          Effect.orElseSucceed(() => []),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(options.out, `${name}-r${round}-screen.txt`),
            labels.join("\n"),
          ),
        );
        skipped.push({ case: name, reason: result.error.slice(0, 300) });
        // A case that failed midway can leave a menu or another tab up; start the next from Home.
        yield* device.reload(session.seeded).pipe(Effect.ignore);
      } else {
        steps.push(...result.measured);
        for (const step of result.measured)
          yield* log(
            `${name} ${step.step} r${round}: content ${step.contentMs ?? "–"} settled ${step.settledMs ?? "–"} commits ${step.commits}`,
          );
      }
    }
  }
  memory.push(yield* memorySample(device, "after-cases", options.out));
  const soak: SoakSample[] = [];
  const sample = Effect.fn("mobileMetrics.soakSample")(function* (iteration: number, name: string) {
    const at = yield* memorySample(device, `soak-${iteration}-${name}`, options.out);
    soak.push({ iteration, case: name, heapMB: at.heapMB, processMB: at.processMB });
    // What the app retains, so heap growth can be traced to atoms or mounted components.
    const retention = yield* device
      .evaluate("__t3Behavior.retention()")
      .pipe(Effect.orElseSucceed(() => null));
    if (typeof retention === "string")
      yield* Effect.promise(() =>
        NodeFSP.appendFile(
          NodePath.join(options.out, "soak-retention.ndjson"),
          `${JSON.stringify({ iteration, case: name, heapMB: at.heapMB, ...JSON.parse(retention) })}\n`,
        ),
      );
    yield* log(`soak ${iteration} ${name}: heap ${at.heapMB} MB, process ${at.processMB} MB`);
  });
  if (options.soak > 0) yield* sample(0, "start");
  for (let iteration = 1; iteration <= options.soak; iteration++) {
    for (const name of SOAK_CASES) {
      const ctx: CaseContext = {
        session,
        device,
        fixtures,
        round: options.rounds + iteration,
        visited,
      };
      const ran = yield* CASES[name](ctx).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          log(`soak ${iteration} ${name}: ${error.message}`).pipe(Effect.as(false)),
        ),
      );
      if (!ran) yield* device.reload(session.seeded).pipe(Effect.ignore);
      yield* sample(iteration, name);
    }
  }
  return {
    steps,
    memory,
    ...(soak.length ? { soak } : {}),
    ...(skipped.length ? { skipped } : {}),
  } satisfies Run;
}, Effect.scoped);

/** Leases the device for a command, keeps the lease alive, and releases it at the end. */
const withLease = Effect.fn("mobileMetrics.withLease")(function* <A, E, R>(
  out: string,
  deviceName: string,
  use: (access: PoolAccess, device: PoolDevice) => Effect.Effect<A, E, R>,
) {
  const runId = DateTime.formatIso(yield* DateTime.now).replaceAll(/[:.]/g, "-");
  return yield* Effect.acquireUseRelease(
    Effect.promise(async () => {
      await NodeFSP.mkdir(out, { recursive: true });
      const access = await openPool(REPO_ROOT, out);
      let device: PoolDevice | null = null;
      try {
        device = await leaseAndInstall(
          {
            id: "metrics",
            platform: "ios",
            device: deviceName,
            form: "phone",
            appearance: "light",
          },
          access.pool,
          `metrics-${runId}`,
          (message) => process.stderr.write(`[mobile-metrics] ${message}\n`),
        );
        const renewing = renewWhileRunning(access, device.session);
        const crashing = releaseOnCrash(device, access);
        return {
          access,
          device,
          stop: () => {
            renewing();
            crashing();
          },
        };
      } catch (error) {
        await device?.release();
        await access.close();
        throw error;
      }
    }),
    ({ access, device }) => use(access, device),
    ({ access, device, stop }) =>
      Effect.promise(async () => {
        stop();
        await device.release();
        await access.close();
      }),
  );
});

const metaFor = Effect.fn("mobileMetrics.metaFor")(function* (
  checkout: string,
  workload: {
    readonly cases: ReadonlyArray<CaseName>;
    readonly rounds: number;
    readonly longTurns: number;
    readonly renders: boolean;
    readonly device: string;
    readonly build: Build;
  },
) {
  return {
    commit: Option.getOrNull(yield* output("git", ["rev-parse", "--short=12", "HEAD"], checkout)),
    device: workload.device,
    platform: "ios-simulator",
    build: workload.build === "release" ? "release" : "development",
    cases: workload.cases.join(","),
    rounds: workload.rounds,
    longTurns: workload.longTurns,
    renders: workload.renders,
    loadBefore: yield* machineLoad,
    measuredAt: DateTime.formatIso(yield* DateTime.now),
  };
});

const writeMetrics = Effect.fn("mobileMetrics.write")(function* (
  file: string,
  metrics: MobileMetrics,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(`${file}.tmp`, `${yield* encodeMetrics(metrics)}\n`);
  yield* fs.rename(`${file}.tmp`, file);
});

const readMetrics = Effect.fn("mobileMetrics.read")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(Effect.flatMap(decodeMetrics));
});

const readFloors = Effect.fn("mobileMetrics.readFloors")(function* (file: Option.Option<string>) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isNone(file)) return undefined;
  return yield* fs.readFileString(file.value).pipe(Effect.flatMap(decodeFloors));
});

/** Prints the comparison and sets exit code 1 when a metric got worse. */
const report = Effect.fn("mobileMetrics.report")(function* (
  before: MobileMetrics,
  after: MobileMetrics,
  threshold: number,
  floors: Floors | undefined,
) {
  const workload = workloadDifferences(before, after);
  if (workload.differ.length > 0)
    return yield* new MetricsError({
      message: `the files ran different workloads (${workload.differ.join("; ")}); rerun one side with the other's settings`,
    });
  const { table, regressed, improved, noisy, compared } = compareSeries(
    flatten(before),
    flatten(after),
    [
      "### Mobile metrics (lower is better)",
      "",
      `before \`${before.meta.commit}\` (${before.runs.length} runs), after \`${after.meta.commit}\` (${after.runs.length} runs), ${before.meta.device}, ${before.meta.build} build${floors ? `, floors calibrated on ${floors.platform}` : ""}`,
    ],
    threshold,
    floors,
  );
  yield* Console.log(table);
  if (before.meta.renders !== after.meta.renders)
    yield* Console.error(
      "Warning: one side counted renders, which slows commits; compare like with like",
    );
  if (compared === 0) return yield* new MetricsError({ message: "the two files share no metric" });
  if (noisy.length)
    yield* Console.error(
      `Moved, but not gated (too noisy, or one run a side): ${noisy.join(", ")}`,
    );
  if (improved.length) yield* Console.error(`Better: ${improved.join(", ")}`);
  if (regressed.length === 0) return;
  yield* Console.error(`Worse: ${regressed.join(", ")}`);
  yield* Effect.sync(() => {
    process.exitCode = 1;
  });
});

/** The render counter reads React's development-only fiber fields. */
const checkBuild = (input: { readonly renders: boolean; readonly build: Build }) =>
  input.renders && input.build === "release"
    ? Effect.fail(new MetricsError({ message: "--renders needs --build dev" }))
    : Effect.void;

const casesOf = (list: string) => {
  const named = list
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (named.length === 0) return Effect.succeed(CASE_NAMES);
  if (named.includes("switches"))
    named.splice(named.indexOf("switches"), 1, "switch-short", "switch-long", "switch-working");
  const unknown = named.filter((entry) => !(CASE_NAMES as ReadonlyArray<string>).includes(entry));
  return unknown.length
    ? Effect.fail(
        new MetricsError({
          message: `unknown cases: ${unknown.join(", ")}; choose from switches, ${CASE_NAMES.join(", ")}`,
        }),
      )
    : Effect.succeed(CASE_NAMES.filter((name) => named.includes(name)));
};

const measureFlags = {
  device: Flag.String("device").pipe(
    Flag.withDescription("Simlock iOS model to lease; compare only runs on one model."),
    Flag.withDefault("iPhone 18 Pro"),
  ),
  rounds: Flag.Int("rounds").pipe(
    Flag.withSchema(PositiveInt),
    Flag.withDescription(
      "Rounds over every case per app launch; a switch's first round is its first visit.",
    ),
    Flag.withDefault(3),
  ),
  longTurns: Flag.Int("long-turns").pipe(
    Flag.withSchema(PositiveInt),
    Flag.withDescription("Turns in the long settled thread."),
    Flag.withDefault(40),
  ),
  cases: Flag.String("cases").pipe(
    Flag.withDescription(
      `Cases, comma separated: switches, ${CASE_NAMES.join(", ")}. Default: all.`,
    ),
    Flag.withDefault(""),
  ),
  renders: Flag.Boolean("renders").pipe(
    Flag.withDescription(
      "Count component renders and their causes per step with the render counter. It slows commits; compare like with like.",
    ),
    Flag.withDefault(false),
  ),
  build: Flag.Literals("build", ["dev", "release"]).pipe(
    Flag.withDescription(
      "dev runs the development bundle; release runs the production bundle as Hermes bytecode on the same dev client (compiling takes a few minutes per launch). Soak in release: dev-build heap grows with dev machinery.",
    ),
    Flag.withDefault("dev"),
  ),
  soak: Flag.Int("soak").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    Flag.withDescription(
      "After the rounds, repeat the switch cases this many times, sampling the Hermes heap and process memory after each, with growth per iteration.",
    ),
    Flag.withDefault(0),
  ),
  host: Flag.String("host").pipe(
    Flag.withDescription(
      "Address the simulator reaches this machine on; defaults to the tailnet IP.",
    ),
    Flag.optional,
  ),
};
const thresholdFlag = Flag.Int("threshold").pipe(
  Flag.withDescription("Percent a metric must move, past its floor, to count."),
  Flag.withDefault(10),
);
const floorsFlag = Flag.String("floors").pipe(
  Flag.withDescription("Floors file from `noise --out`."),
  Flag.optional,
);

const runCommand = Command.make(
  "run",
  {
    ...measureFlags,
    out: Flag.String("out").pipe(
      Flag.withDescription("JSON file to write."),
      Flag.withDefault("mobile-metrics.json"),
    ),
    checkout: Flag.String("checkout").pipe(
      Flag.withDescription("Checkout whose app Metro serves, with dependencies installed."),
      Flag.withDefault(REPO_ROOT),
    ),
  },
  Effect.fn("mobileMetrics.run")(function* (input) {
    const checkout = NodePath.resolve(input.checkout);
    const out = NodePath.resolve(input.out);
    const cases = yield* casesOf(input.cases);
    yield* checkBuild(input);
    const meta = yield* metaFor(checkout, { ...input, cases });
    const artifacts = `${out.replace(/\.json$/, "")}-artifacts`;
    const measured = yield* withLease(artifacts, input.device, (access, device) =>
      Effect.gen(function* () {
        if (checkout !== REPO_ROOT) yield* Effect.promise(() => device.install(checkout));
        return yield* measureOnce({
          checkout,
          out: NodePath.join(artifacts, "run-1"),
          access,
          deviceSession: device.session,
          cases,
          rounds: input.rounds,
          longTurns: input.longTurns,
          renders: input.renders,
          soak: input.soak,
          build: input.build,
          host: Option.getOrElse(input.host, reachableHost),
        });
      }),
    );
    const metrics: MobileMetrics = {
      meta: { ...meta, loadAfter: yield* machineLoad },
      runs: [measured],
    };
    yield* writeMetrics(out, metrics);
    yield* Console.log(summaryTable(metrics));
  }),
).pipe(
  Command.withDescription(
    "Lease a Simlock iOS simulator, seed a server (replayed threads, a 40-file branch with a PR on a fake GitHub), open a checkout's dev client and measure each case.",
  ),
);

const abCommand = Command.make(
  "ab",
  {
    ...measureFlags,
    checkoutA: Argument.String("checkout-a").pipe(Argument.withDescription("Baseline checkout.")),
    checkoutB: Argument.String("checkout-b").pipe(Argument.withDescription("Candidate checkout.")),
    abRounds: Flag.Int("ab-rounds").pipe(
      Flag.withSchema(PositiveInt),
      Flag.withDescription(
        "App launches a side; each round runs A and B once, alternating which goes first.",
      ),
      Flag.withDefault(2),
    ),
    outDir: Flag.String("out-dir").pipe(Flag.withDefault("mobile-metrics-ab")),
    threshold: thresholdFlag,
    floors: floorsFlag,
  },
  Effect.fn("mobileMetrics.ab")(function* (input) {
    const outDir = NodePath.resolve(input.outDir);
    const cases = yield* casesOf(input.cases);
    yield* checkBuild(input);
    const floors = yield* readFloors(input.floors);
    const checkouts = [
      NodePath.resolve(input.checkoutA),
      NodePath.resolve(input.checkoutB),
    ] as const;
    const metas = [
      yield* metaFor(checkouts[0], { ...input, cases }),
      yield* metaFor(checkouts[1], { ...input, cases }),
    ] as const;
    const host = Option.getOrElse(input.host, reachableHost);
    let launches = 0;
    const saved = yield* withLease(outDir, input.device, (access, device) =>
      runAbRounds({
        rounds: input.abRounds,
        outDir,
        runSide: Effect.fn("mobileMetrics.abSide")(function* (side: 0 | 1) {
          // Each side's dev client, from the cache when both share a native fingerprint.
          yield* Effect.promise(() => device.install(checkouts[side]));
          return yield* measureOnce({
            checkout: checkouts[side],
            out: NodePath.join(outDir, `${side === 0 ? "a" : "b"}-${++launches}`),
            access,
            deviceSession: device.session,
            cases,
            rounds: input.rounds,
            longTurns: input.longTurns,
            renders: input.renders,
            soak: input.soak,
            build: input.build,
            host,
          });
        }),
        save: Effect.fn("mobileMetrics.abSave")(function* (side: 0 | 1, runs: ReadonlyArray<Run>) {
          const file: MobileMetrics = {
            meta: { ...metas[side], loadAfter: yield* machineLoad },
            runs: [...runs],
          };
          yield* writeMetrics(NodePath.join(outDir, side === 0 ? "a.json" : "b.json"), file);
          return file;
        }),
      }),
    );
    yield* report(saved[0], saved[1], input.threshold, floors);
  }),
).pipe(
  Command.withDescription(
    "Run two checkouts alternately (A B, then B A) on one leased simulator and compare them. The harness, server and seed come from this script; each side's Metro serves its own app.",
  ),
);

const compareCommand = Command.make(
  "compare",
  {
    before: Argument.String("before").pipe(Argument.withDescription("Baseline JSON.")),
    after: Argument.String("after").pipe(Argument.withDescription("Candidate JSON.")),
    threshold: thresholdFlag,
    floors: floorsFlag,
  },
  Effect.fn("mobileMetrics.compare")(function* (input) {
    yield* report(
      yield* readMetrics(input.before),
      yield* readMetrics(input.after),
      input.threshold,
      yield* readFloors(input.floors),
    );
  }),
).pipe(
  Command.withDescription(
    "Markdown table of two result files, gated like client-metrics: each app launch's median is one sample, and a metric counts only with 2+ launches a side when its bootstrap interval clears the threshold and floor. Exits 1 on a regression.",
  ),
);

const noiseCommand = Command.make(
  "noise",
  {
    dirs: Argument.String("dir").pipe(
      Argument.withDescription("An `ab` out dir of one checkout against itself."),
      Argument.atLeast(1),
    ),
    out: Flag.String("out").pipe(Flag.withDescription("Floors file to write."), Flag.optional),
  },
  Effect.fn("mobileMetrics.noise")(function* (input) {
    const fs = yield* FileSystem.FileSystem;
    const pairs = yield* Effect.forEach(input.dirs, (dir) =>
      Effect.gen(function* () {
        const a = yield* readMetrics(NodePath.join(dir, "a.json"));
        const b = yield* readMetrics(NodePath.join(dir, "b.json"));
        const settings = workloadDifferences(a, b, [...WORKLOAD_KEYS, ...PROBE_KEYS]).differ;
        if (a.meta.commit !== b.meta.commit || settings.length > 0)
          return yield* new MetricsError({
            message: `${dir}: floors need one commit against itself with one set of settings`,
          });
        return [flatten(a), flatten(b)] as const;
      }),
    );
    const { floors, table } = noiseOfSeries(pairs, "ios-simulator");
    yield* Console.log(table);
    if (Option.isSome(input.out))
      yield* fs.writeFileString(input.out.value, `${yield* encodeFloors(floors)}\n`);
  }),
).pipe(Command.withDescription("Each metric's A/A spread and a floor for `compare --floors`."));

const summaryCommand = Command.make(
  "summary",
  { file: Argument.String("file").pipe(Argument.withDescription("A result JSON.")) },
  Effect.fn("mobileMetrics.summary")(function* (input) {
    yield* Console.log(summaryTable(yield* readMetrics(input.file)));
  }),
).pipe(Command.withDescription("Print a result file's tables."));

const command = Command.make("mobile-metrics").pipe(
  Command.withDescription(
    `Measure the iOS app on a Simlock simulator with mobile:behavior's server, Metro and behavior probe. Needs SIMLOCK_AGENT_DEVICE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN.

Cases (real taps, swipes and typing through agent-device):
  switch-short, switch-long   Tap a Home row: tap to the frame showing the thread's rows.
  switch-working   A thread streaming a reply, opened twice; each round starts and stops its own.
  tabs             PRs, Usage, then Chats in the tab bar.
  pull-request     The PR list, then the branch PR (40 files, long body, comments; fake GitHub).
  issues           The issues list, which shares the PR tab's slot.
  diff             A thread's git menu, then Review changes on the 40-file branch.
  side-chat        A thread's side chat chip.
  type             Keys typed into a composer, each to its next JS frame.
  scroll-long      Drag up through the long timeline: JS and UI frame drops.

\`--build dev\` (the default) runs the development bundle: render and commit counts and A/B
differences are representative, absolute times and heap growth are not. \`--build release\` runs
the production bundle as Hermes bytecode: real times and a flat heap, but no commit ms, no
\`--renders\`, and minified component names in soak retention. Soak in release. Trust a change
only from \`ab\` on one simulator model and build.`,
  ),
  Command.withSubcommands([runCommand, abCommand, compareCommand, noiseCommand, summaryCommand]),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide([NodeServices.layer, NodeCrypto.layer]),
    Effect.catchTags({
      MetricsError: (error) =>
        Console.error(`mobile-metrics: ${error.message}`).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
    }),
    NodeRuntime.runMain,
  );
}
