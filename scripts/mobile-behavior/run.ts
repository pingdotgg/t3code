#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off - writes result files.
/**
 * Drives the T3 Code iOS dev client on one simulator against an isolated server with scripted
 * replies, and grades app behavior from the dev-only probe and server state. See README.md.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";

import { CASES, type MobileBehaviorCase } from "./cases.ts";
import { DeviceError } from "./device.ts";
import { blockingResults, checkFails, resultsFor, summarize, type SampleRow } from "./grade.ts";
import { SCENARIOS, type Pose, type ScenarioContext } from "./scenarios.ts";
import { reachableHost, startSession } from "./session.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../..");
const POSES = ["phone", "duo-closed", "duo-open", "ipad"] as const satisfies ReadonlyArray<Pose>;

const decodeRows = (file: string): ReadonlyArray<SampleRow> =>
  NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SampleRow);

const command = Command.make(
  "mobile-behavior",
  {
    out: Flag.String("out").pipe(Flag.withDescription("Directory for results and run state.")),
    device: Flag.String("device").pipe(
      Flag.withDescription(
        "Simulator UDID; leave out for a Simlock lease, whose gateway picks it.",
      ),
      Flag.withDefault(""),
    ),
    deviceConfig: Flag.String("device-config").pipe(
      Flag.withDescription("The --config path device_open returned for this device."),
    ),
    deviceSession: Flag.String("device-session").pipe(
      Flag.withDescription("The --session name device_open returned for this device."),
    ),
    deviceName: Flag.String("device-name").pipe(
      Flag.withDescription(
        'Simulator name as Metro lists it, e.g. "iPhone 17 Pro". Leave out when this run\'s Metro serves one device.',
      ),
      Flag.withDefault(""),
    ),
    pose: Flag.Literals("pose", POSES).pipe(Flag.withDefault<Pose>("phone")),
    label: Flag.String("label").pipe(
      Flag.withDescription("Column name in the scoreboard; defaults to the pose."),
      Flag.optional,
    ),
    cases: Flag.String("case").pipe(
      Flag.withDescription("Comma-separated case ids."),
      Flag.optional,
    ),
    samples: Flag.Int("samples").pipe(Flag.withDefault(3)),
    baseline: Flag.String("baseline").pipe(
      Flag.withDescription("results.jsonl from an earlier run to compare against."),
      Flag.optional,
    ),
    agentDevice: Flag.String("agent-device").pipe(
      Flag.withDefault(
        NodePath.join(REPO_ROOT, "scripts/node_modules/agent-device/bin/agent-device.mjs"),
      ),
    ),
    forgetOtherEnvironments: Flag.Boolean("forget-other-environments").pipe(
      Flag.withDescription(
        "Remove the app's other saved environments first. Only for a simulator kept for this eval.",
      ),
      Flag.withDefault(false),
    ),
    host: Flag.String("host").pipe(
      Flag.withDescription(
        "Address the simulator uses to reach this machine; defaults to the tailnet IP.",
      ),
      Flag.optional,
    ),
  },
  Effect.fn("mobileBehavior.main")(function* (flags) {
    const out = NodePath.resolve(flags.out);
    // Read first: the baseline may be this --out's own results.jsonl, which the run rewrites.
    const baseline = Option.map(flags.baseline, (file) => resultsFor(decodeRows(file), CASES));
    NodeFS.mkdirSync(out, { recursive: true });
    const label = Option.getOrElse(flags.label, () => flags.pose);
    const wanted = Option.map(flags.cases, (ids) => new Set(ids.split(",").map((id) => id.trim())));
    const selected = CASES.filter(
      (testCase) =>
        Option.match(wanted, { onNone: () => true, onSome: (ids) => ids.has(testCase.id) }) &&
        (testCase.poses?.includes(flags.pose) ?? true),
    );
    const unknown = Option.match(wanted, {
      onNone: () => [],
      onSome: (ids) => [...ids].filter((id) => !CASES.some((testCase) => testCase.id === id)),
    });
    if (unknown.length > 0)
      return yield* new DeviceError({ message: `Unknown case id(s): ${unknown.join(", ")}.` });
    if (selected.length === 0) return yield* new DeviceError({ message: "No cases match." });
    const host = Option.getOrElse(flags.host, reachableHost);
    const startedAt = yield* Clock.currentTimeMillis;

    const { env, device, longThread, seeded } = yield* startSession({
      out,
      host,
      agentDevice: flags.agentDevice,
      deviceConfig: flags.deviceConfig,
      deviceSession: flags.deviceSession,
      device: flags.device,
      deviceName: flags.deviceName,
      ...(flags.pose === "duo-closed" ? { fold: "closed" as const } : {}),
      ...(flags.pose === "duo-open" ? { fold: "open" as const } : {}),
      forgetOtherEnvironments: flags.forgetOtherEnvironments,
      longTurns: 60,
    });
    const ctx: ScenarioContext = {
      env,
      device,
      pose: flags.pose,
      fixtures: { longThread },
    };
    const scenarios = [...new Set(selected.map((testCase) => testCase.scenario))];
    const rows: SampleRow[] = [];
    const resultsFile = NodeFS.openSync(NodePath.join(out, "results.jsonl"), "w");
    for (const scenario of scenarios) {
      const cases = selected.filter((testCase) => testCase.scenario === scenario);
      for (let sample = 1; sample <= flags.samples; sample++) {
        const outcome = yield* env.interruptAll().pipe(
          Effect.andThen(env.archiveAllExcept(longThread)),
          Effect.andThen(device.reload(seeded)),
          Effect.andThen(SCENARIOS[scenario](ctx)),
          Effect.map((metrics) => ({ metrics, error: undefined })),
          Effect.catch((error) => Effect.succeed({ metrics: {}, error: error.message })),
          // A bad probe reply or snapshot must cost one sample, not the run.
          Effect.catchDefect((defect) => Effect.succeed({ metrics: {}, error: String(defect) })),
        );
        for (const testCase of cases) {
          const failures = outcome.error
            ? []
            : testCase.checks.flatMap((check) => checkFails(check, outcome.metrics) ?? []);
          const row: SampleRow = {
            id: testCase.id,
            device: label,
            sample,
            pass: outcome.error ? null : failures.length === 0,
            failures,
            metrics: outcome.metrics,
            ...(outcome.error ? { error: outcome.error } : {}),
          };
          rows.push(row);
          NodeFS.writeSync(resultsFile, `${JSON.stringify(row)}\n`);
          yield* Console.error(
            `${testCase.id} #${sample}: ${row.pass === null ? row.error : row.pass ? "pass" : `FAIL ${failures.join("; ")}`}`,
          );
        }
      }
    }
    NodeFS.closeSync(resultsFile);
    const minutes = Math.round(((yield* Clock.currentTimeMillis) - startedAt) / 60_000);
    const results = resultsFor(rows, CASES);
    const summary = summarize({
      cases: selected as ReadonlyArray<MobileBehaviorCase>,
      results,
      ...Option.match(baseline, { onNone: () => ({}), onSome: (rows) => ({ baseline: rows }) }),
      header: `# Mobile behavior: ${label}\n\n${flags.deviceName || label}, ${flags.samples} samples per case, ${minutes} min. Cells show pass or FAIL and the key metric's median.`,
    });
    NodeFS.writeFileSync(NodePath.join(out, "summary.md"), summary);
    yield* Console.log(summary);
    if (blockingResults(results, CASES).length > 0) process.exitCode = 1;
  }, Effect.scoped),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide([NodeServices.layer, NodeCrypto.layer]),
  NodeRuntime.runMain,
);
