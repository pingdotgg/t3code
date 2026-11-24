import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { patchNumberFromId } from "../shared/definition.ts";
import { parseJobLog } from "./radicleJobJson.ts";
import * as RadiclePullRequestProvider from "./RadiclePullRequestProvider.ts";
import {
  CI_NODE,
  PATCH,
  PATCH_HEAD,
  RID,
  jobOps,
  radicleLayer,
  type Run,
} from "./radicleTestFixtures.ts";

const ref = { cwd: "/repo", host: "radicle", repository: `rad:${RID.toLowerCase()}` };
const number = patchNumberFromId(PATCH);
const withCi = (ciRerunCommand = "rerun-ci") => ({
  ...DEFAULT_SERVER_SETTINGS,
  sourceControlHosts: {
    ...DEFAULT_SERVER_SETTINGS.sourceControlHosts,
    radicle: { ciHost: "ci-host", ciRerunCommand },
  },
});

it("reads a job's commit and runs, even when a run finishes in the second it started", () => {
  // `rad cob log --format json` from radicle-ci-broker 0.32.1, newest first, with one rerun.
  const job = parseJobLog(
    "19047f29166a5bc1f2125c728df26b66fa56869e",
    [
      `{"actions":[{"Finished":{"reason":"Succeeded","uuid":"bc25"}}],"author":"${CI_NODE}","timestamp":1795480429000}`,
      `{"actions":[{"Run":{"log":"file:///var/lib/ci/2.log","uuid":"bc25"}}],"author":"${CI_NODE}","timestamp":1795480429000}`,
      `{"actions":[{"Finished":{"reason":"Failed","uuid":"42a1"}}],"author":"${CI_NODE}","timestamp":1795480183000}`,
      `{"actions":[{"Run":{"log":"file:///var/lib/ci/1.log","uuid":"42a1"}}],"author":"${CI_NODE}","timestamp":1795480181000}`,
      `{"actions":[{"Request":{"oid":"e02cadacafa7049307f49b4de10c0cf87f75aba2"}}],"author":"${CI_NODE}","timestamp":1795480181000}`,
    ].join("\n"),
  );
  assert.strictEqual(job?.commit, "e02cadacafa7049307f49b4de10c0cf87f75aba2");
  assert.deepStrictEqual(
    job?.runs.map((run) => [run.uuid, run.result]),
    [
      ["42a1", "Failed"],
      ["bc25", "Succeeded"],
    ],
  );
});

it.effect("shows one check per CI node from its latest run of the patch head", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const provider = yield* RadiclePullRequestProvider.make;
    const { checks } = yield* provider.getChangeRequestChecks!({ ...ref, number });
    assert.deepStrictEqual(checks, [
      {
        name: `CI (${CI_NODE.slice(0, 7)}…${CI_NODE.slice(-7)})`,
        status: "success",
        description: "Succeeded",
        url: "file:///var/lib/ci/reports/second.log",
      },
    ]);
  }).pipe(
    Effect.provide(
      radicleLayer({
        runs,
        jobs: {
          // A rerun can open a new job for the same commit; the newer run is the one shown.
          aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: jobOps(PATCH_HEAD, [
            { uuid: "first", at: 1_000, result: "Failed" },
          ]),
          bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: jobOps(PATCH_HEAD, [
            { uuid: "second", at: 2_000, result: "Succeeded" },
          ]),
          cccccccccccccccccccccccccccccccccccccccc: jobOps(
            "0000000000000000000000000000000000000000",
            [{ uuid: "other", at: 3_000, result: "Failed" }],
          ),
        },
      }),
    ),
  );
});

it.effect("reports a run that has not finished as pending", () =>
  Effect.gen(function* () {
    const provider = yield* RadiclePullRequestProvider.make;
    const { checks } = yield* provider.getChangeRequestChecks!({ ...ref, number });
    assert.strictEqual(checks[0]?.status, "pending");
    assert.strictEqual(checks[0]?.description, "Running");
  }).pipe(
    Effect.provide(
      radicleLayer({
        runs: [],
        jobs: {
          aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: jobOps(PATCH_HEAD, [
            { uuid: "now", at: 1_000 },
          ]),
        },
      }),
    ),
  ),
);

it.effect("reads a log over ssh on the CI host and refuses a path a shell would split", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const provider = yield* RadiclePullRequestProvider.make;
    const [log, unsafe, escaped] = yield* provider.getCheckLogs!({
      ...ref,
      checks: [
        { name: "CI", url: "file:///var/lib/ci/reports/run.log" },
        { name: "CI", url: "file:///var/lib/ci/x;rm -rf ~" },
        { name: "CI", url: "file:///var/lib/ci/bad%.log" },
      ],
      tailLines: 1,
    });
    assert.strictEqual(log?.log, "job exit status 1");
    assert.isTrue(log?.truncated);
    assert.isNull(unsafe?.log);
    assert.isNotNull(unsafe?.detail);
    assert.isNull(escaped?.log);
    assert.isNotNull(escaped?.detail);
    const ssh = runs.filter((run) => run.command === "ssh");
    assert.deepStrictEqual(
      ssh.map((run) => run.args),
      [
        [
          "-o",
          "BatchMode=yes",
          "--",
          "ci-host",
          "tail",
          "-c",
          String(4 * 1024 * 1024),
          "--",
          "/var/lib/ci/reports/run.log",
        ],
      ],
    );
  }).pipe(Effect.provide(radicleLayer({ runs, settings: withCi() })));
});

it.effect("reruns the job a check's log belongs to with the configured command", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const provider = yield* RadiclePullRequestProvider.make;
    const [rerun, unknown] = yield* provider.rerunChecks!({
      ...ref,
      checks: [
        { name: "CI", url: "file:///var/lib/ci/reports/first.log" },
        { name: "CI", url: "file:///var/lib/ci/reports/missing.log" },
      ],
    });
    assert.isTrue(rerun?.rerun);
    assert.isFalse(unknown?.rerun);
    assert.deepStrictEqual(
      runs.filter((run) => run.command === "ssh").map((run) => run.args),
      [["-o", "BatchMode=yes", "--", "ci-host", "rerun-ci", `rad:${RID}`, PATCH_HEAD]],
    );
  }).pipe(
    Effect.provide(
      radicleLayer({
        runs,
        settings: withCi(),
        jobs: {
          aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: jobOps(PATCH_HEAD, [
            { uuid: "first", at: 1_000, result: "Failed" },
          ]),
        },
      }),
    ),
  );
});

it.effect("asks for a rerun command rather than guessing one", () =>
  Effect.gen(function* () {
    const provider = yield* RadiclePullRequestProvider.make;
    const [rerun] = yield* provider.rerunChecks!({
      ...ref,
      checks: [{ name: "CI", url: "file:///var/lib/ci/reports/first.log" }],
    });
    assert.isFalse(rerun?.rerun);
    assert.include(rerun?.detail ?? "", "rerun command");
  }).pipe(
    Effect.provide(
      radicleLayer({
        runs: [],
        settings: withCi(""),
        jobs: {
          aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: jobOps(PATCH_HEAD, [
            { uuid: "first", at: 1_000, result: "Failed" },
          ]),
        },
      }),
    ),
  ),
);
