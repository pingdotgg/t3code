#!/usr/bin/env node
// Runs one scenario with `e2e run` on a base and a head commit and says whether it fails on
// base and passes on head. See docs/operations/scenarios.md.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { run, ScenarioError } from "./scenarios/shell.ts";

/** The parts of e2e's report.json (schema/report-v1.schema.json) a proof reads. */
const E2EReport = Schema.Struct({
  run: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        titlePath: Schema.Array(Schema.String),
        attempts: Schema.Array(
          Schema.Struct({
            status: Schema.optional(Schema.String),
            steps: Schema.Array(
              Schema.Struct({
                api: Schema.String,
                label: Schema.optional(Schema.String),
                status: Schema.String,
              }),
            ),
            error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
            artifacts: Schema.optional(
              Schema.Array(
                Schema.Struct({ kind: Schema.String, path: Schema.optional(Schema.String) }),
              ),
            ),
          }),
        ),
      }),
    ),
  }),
});
type E2EReport = typeof E2EReport.Type;
const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(E2EReport));
const encodeProof = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

export interface SideResult {
  readonly sha: string;
  /** `error`: the scenario could not run, which says nothing about the behavior. */
  readonly status: "passed" | "failed" | "error";
  readonly title: string;
  readonly message?: string;
  /**
   * For `error`, what stopped: `app` when the app did not start or no test ran, `scenario` when
   * the app ran and the scenario stopped before its assertion, such as on a control it did not find.
   */
  readonly stopped?: "app" | "scenario";
  readonly steps: ReadonlyArray<{ readonly step: string; readonly status: string }>;
  /** Capture paths under the run's results directory, in the order the scenario took them. */
  readonly captures: ReadonlyArray<string>;
  readonly videos: ReadonlyArray<string>;
}

/** Only a failed expectation shows the bug. A missing control or a dead app shows nothing. */
export function readSide(
  sha: string,
  resultsDir: string,
  report: E2EReport | undefined,
): SideResult {
  // The report also lists the tests the run did not select, with no attempts.
  const executed = report?.run.results.filter((candidate) => candidate.attempts.length > 0) ?? [];
  // One scenario is one test: with several, a pass in the first could hide a failure in another.
  const result = executed.length === 1 ? executed[0] : undefined;
  const attempt = result?.attempts.at(-1);
  if (result === undefined || attempt === undefined) {
    const message =
      executed.length > 1
        ? `the scenario file ran ${executed.length} tests; a proof needs exactly one`
        : "e2e wrote no report: the app did not start, or no test was selected";
    return {
      sha,
      status: "error",
      stopped: "app",
      title: "",
      message,
      steps: [],
      captures: [],
      videos: [],
    };
  }
  const files = (kind: string) =>
    (attempt.artifacts ?? []).flatMap((artifact) =>
      artifact.kind === kind && artifact.path !== undefined
        ? [`${resultsDir}/${artifact.path}`]
        : [],
    );
  const error = attempt.error;
  // e2e exits 0 for a skipped test too, and a test that did not run proves nothing.
  const status =
    attempt.status === "passed"
      ? "passed"
      : error?.code === "ASSERTION_FAILED"
        ? "failed"
        : "error";
  return {
    sha,
    status,
    // A test that ended with an error of its own got as far as the app.
    ...(status === "error" ? { stopped: error === undefined ? "app" : "scenario" } : {}),
    title: result.titlePath.join(" > "),
    ...(error === undefined
      ? attempt.status === "passed"
        ? {}
        : { message: `the test ended ${attempt.status ?? "without a status"}` }
      : { message: `${error.code}: ${error.message}` }),
    steps: attempt.steps.map((step) => ({
      // The sign-in step's label holds the run's pairing token.
      step: `${step.api} ${step.label?.includes("token=") ? "<pairing link>" : (step.label ?? "")}`,
      status: step.status,
    })),
    captures: files("screenshot"),
    videos: files("video"),
  };
}

const short = (sha: string) => sha.slice(0, 10);
const captureLabel = (path: string) =>
  (path.split("/").at(-1) ?? "")
    .replace(/\.png$/, "")
    .replace(/^\d+-/, "")
    .replaceAll("-", " ");

/** `link` maps a capture path to what the Markdown should point at, such as an uploaded URL. */
export function buildProof(base: SideResult, head: SideResult, link: (path: string) => string) {
  const baseSha = `\`${short(base.sha)}\``;
  const headSha = `\`${short(head.sha)}\``;
  const broken = base.status === "error" ? base : head.status === "error" ? head : undefined;
  const verdict =
    broken !== undefined
      ? `Not proven: the scenario could not run on ${broken === base ? `base ${baseSha}` : `head ${headSha}`} (${broken.message ?? "unknown error"}).${broken.stopped === "scenario" ? " The app ran and the scenario stopped before its assertion: fix the scenario and run it again." : ""}`
      : base.status === "passed"
        ? head.status === "passed"
          ? `Not proven: the scenario passes on base ${baseSha} too, so it does not reproduce the bug.`
          : `Not proven: the scenario passes on base ${baseSha} and fails on head ${headSha}, so head breaks it.`
        : head.status === "passed"
          ? `Proven: the scenario fails on base ${baseSha} and passes on head ${headSha}.`
          : `Not proven: the scenario fails on base ${baseSha} and still fails on head ${headSha}.`;

  const labels = [...new Set([...base.captures, ...head.captures].map(captureLabel))];
  const cell = (side: string, result: SideResult, label: string) => {
    const capture = result.captures.find((path) => captureLabel(path) === label);
    return capture === undefined
      ? ""
      : `![${side} ${short(result.sha)}: ${label}](${link(capture)})`;
  };
  const outcome = (result: SideResult) =>
    result.status === "passed"
      ? "✅ passed"
      : `${result.status === "failed" ? "❌ failed" : "⚠️ could not run"}<br>${(result.message ?? "").replaceAll("\n", "<br>").replaceAll("|", "\\|").replaceAll("<br><br>", "<br>")}`;
  const markdown = [
    `### Scenario: ${head.title || base.title}`,
    "",
    `**${verdict}**`,
    "",
    `|  | Base ${baseSha} | Head ${headSha} |`,
    "| --- | --- | --- |",
    `| Result | ${outcome(base)} | ${outcome(head)} |`,
    ...labels.map(
      (label) => `| ${label} | ${cell("Base", base, label)} | ${cell("Head", head, label)} |`,
    ),
    "",
  ].join("\n");
  return {
    scenario: head.title || base.title,
    failsOnBase: base.status === "failed",
    passesOnHead: head.status === "passed",
    /** Why there is no verdict on the behavior: the app did not run, or the scenario stopped. */
    couldNotRun: broken?.stopped ?? null,
    baseSha: base.sha,
    headSha: head.sha,
    verdict,
    steps: { base: base.steps, head: head.steps },
    captures: [...base.captures, ...head.captures],
    videos: [...base.videos, ...head.videos],
    markdown,
    base,
    head,
  };
}

const roots = Effect.gen(function* () {
  const path = yield* Path.Path;
  const scripts = yield* path.fromFileUrl(new URL(".", import.meta.url));
  return { scripts, repo: path.dirname(path.resolve(scripts)) };
});

const git = Effect.fn("prove.git")(function* (args: ReadonlyArray<string>) {
  return (yield* run("git", args, { cwd: (yield* roots).repo })).stdout.trim();
});

/** Runs `use` with a checkout of `sha`: this one when it already is that commit, else a worktree. */
const withCheckout = Effect.fn("prove.withCheckout")(function* <A, E, R>(
  sha: string,
  use: (appDir: string) => Effect.Effect<A, E, R>,
) {
  const { repo } = yield* roots;
  const clean = (yield* git(["status", "--porcelain", "--untracked-files=no"])).length === 0;
  if (clean && (yield* git(["rev-parse", "HEAD"])) === sha) return yield* use(repo);
  // Beside this checkout, not in the temp directory, so tooling resolves as it does here.
  const worktree = `${repo}-scenario-${short(sha)}`;
  // A run that was killed left its worktree behind, and git refuses to add over it.
  const discard = git(["worktree", "remove", "--force", worktree]).pipe(
    Effect.ignore,
    Effect.andThen(git(["worktree", "prune"])),
    Effect.ignore,
  );
  return yield* Effect.acquireUseRelease(
    discard.pipe(
      Effect.andThen(git(["worktree", "add", "--quiet", "--detach", "--force", worktree, sha])),
    ),
    () => run("vp", ["i"], { cwd: worktree, echo: true }).pipe(Effect.andThen(use(worktree))),
    () => discard,
  );
});

/** Runs the scenario with `e2e run` against the app at `sha` and reads the report it wrote. */
const runSide = Effect.fn("prove.runSide")(function* (
  side: "base" | "head",
  rev: string,
  scenarioPath: string,
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { scripts } = yield* roots;
  const sha = yield* git(["rev-parse", "--verify", `${rev}^{commit}`]);
  const outDir = path.join(scripts, ".e2e/prove", side);
  yield* fs.remove(outDir, { recursive: true, force: true });
  const environment = yield* HostProcess.Environment;
  yield* withCheckout(sha, (appDir) =>
    // The scenario and e2e come from this checkout; only the app comes from `appDir`.
    run(
      path.join(scripts, "node_modules/.bin/e2e"),
      ["run", scenarioPath, "--target", target, "--output", path.relative(scripts, outDir)],
      {
        cwd: scripts,
        env: { ...environment, T3_SCENARIO_APP_DIR: appDir, E2E_TELEMETRY_DISABLED: "1" },
        // The report says how the run went; e2e's exit code only repeats it.
        allowExit: [0, 1, 2, 3, 4],
        echo: true,
      },
    ),
  );
  const report = yield* fs.readFileString(path.join(outDir, "report.json")).pipe(
    Effect.flatMap(decodeReport),
    Effect.orElseSucceed(() => undefined),
  );
  const result = readSide(sha, path.join(outDir, "results"), report);
  // Written as each side ends, so a proof whose second side is cut short still has its first.
  yield* fs
    .writeFileString(
      path.join(scripts, ".e2e/prove", `${side}.json`),
      `${yield* encodeProof(result)}\n`,
    )
    .pipe(Effect.ignore);
  return result;
});

/** The one target a scenario runs on: an iOS scenario imports `t3-mobile.ts`, a web one does not. */
const targetOf = Effect.fn("prove.targetOf")(function* (scenarioPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(scenarioPath).pipe(Effect.orElseSucceed(() => ""));
  return source.includes("t3-mobile") ? "ios" : "web";
});

/** Uploads the captures and maps each to its URL; a failed upload leaves the map empty. */
const upload = Effect.fn("prove.upload")(function* (
  uploadCommand: string,
  captures: ReadonlyArray<string>,
) {
  const [command = "", ...args] = uploadCommand.split(/\s+/).filter(Boolean);
  if (captures.length === 0) return new Map<string, string>();
  return yield* run(command, [...args, ...captures]).pipe(
    Effect.map((result) => result.stdout.trim().split("\n")),
    // Lines pair with captures by position, so a different count would mislabel every image.
    Effect.filterOrFail(
      (urls) => urls.length === captures.length,
      () => new ScenarioError({ message: "The upload command printed an unexpected line count." }),
    ),
    Effect.map((urls) => new Map(captures.map((capture, index) => [capture, urls[index] ?? ""]))),
    // Two finished runs are worth more than their links: the proof then names local files.
    Effect.catch((error) =>
      Console.error(`Upload failed, linking local captures: ${error.message}`).pipe(
        Effect.as(new Map<string, string>()),
      ),
    ),
  );
});

const prove = Effect.fn("prove")(function* (input: {
  readonly scenario: string;
  readonly base: string;
  readonly head: string;
  readonly uploadCommand: Option.Option<string>;
  readonly target: Option.Option<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { scripts } = yield* roots;
  const proveDir = path.join(scripts, ".e2e/prove");
  const scenarioPath = path.resolve(yield* HostProcess.WorkingDirectory, input.scenario);
  // A proof left by an earlier run must not be read as this one's.
  yield* fs.remove(proveDir, { recursive: true, force: true });
  yield* fs.makeDirectory(proveDir, { recursive: true });
  // Only that target's app starts: a web scenario needs no Metro and no device.
  const target = Option.getOrElse(input.target, () => "") || (yield* targetOf(scenarioPath));
  const base = yield* runSide("base", input.base, scenarioPath, target);
  const head = yield* runSide("head", input.head, scenarioPath, target);
  const links = Option.isSome(input.uploadCommand)
    ? yield* upload(input.uploadCommand.value, [...base.captures, ...head.captures])
    : new Map<string, string>();
  const proof = buildProof(
    base,
    head,
    (capture) => links.get(capture) ?? path.relative(proveDir, capture),
  );
  const json = yield* encodeProof(proof);
  yield* fs.writeFileString(path.join(proveDir, "proof.md"), proof.markdown);
  yield* fs.writeFileString(path.join(proveDir, "proof.json"), `${json}\n`);
  yield* Console.log(json);
  return proof.failsOnBase && proof.passesOnHead
    ? 0
    : proof.couldNotRun === "scenario"
      ? 3
      : proof.couldNotRun === "app"
        ? 2
        : 1;
});

const command = Command.make(
  "prove-scenario",
  {
    scenario: Argument.String("scenario").pipe(
      Argument.withDescription("Scenario file, such as scripts/scenarios/name.e2e.ts."),
    ),
    base: Flag.String("base").pipe(Flag.withDescription("Commit the bug shows on.")),
    head: Flag.String("head").pipe(
      Flag.withDescription("Commit with the fix."),
      Flag.withDefault("HEAD"),
    ),
    uploadCommand: Flag.String("upload-command").pipe(
      Flag.withDescription("Command that takes capture paths and prints one URL per line."),
      Flag.optional,
    ),
    target: Flag.String("target").pipe(
      Flag.withDescription(
        "Target to run on: web or ios. Default: ios when the scenario imports t3-mobile.ts, else web.",
      ),
      Flag.optional,
    ),
  },
  (input) =>
    prove(input).pipe(
      // A bad revision or a failed install is "could not run" (2), not "did not prove" (1).
      Effect.catch((error) => Console.error(String(error)).pipe(Effect.as(2))),
      Effect.flatMap((exitCode) =>
        Effect.sync(() => {
          process.exitCode = exitCode;
        }),
      ),
    ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
