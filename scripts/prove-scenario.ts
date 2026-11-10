#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Runs one scenario with `e2e run` on a base and a head commit and says whether it fails on
// base and passes on head. See docs/operations/scenarios.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const SCRIPTS = import.meta.dirname;
const REPO_ROOT = NodePath.dirname(SCRIPTS);

/** The parts of e2e's report.json (schema/report-v1.schema.json) a proof reads. */
interface E2EReport {
  readonly run: {
    readonly exitCode: number;
    readonly results: ReadonlyArray<{
      readonly titlePath: ReadonlyArray<string>;
      readonly attempts: ReadonlyArray<{
        readonly steps: ReadonlyArray<{ api: string; label?: string; status: string }>;
        readonly error?: { readonly code: string; readonly message: string };
        readonly artifacts?: ReadonlyArray<{ readonly kind: string; readonly path?: string }>;
      }>;
    }>;
  };
}

export interface SideResult {
  readonly sha: string;
  /** `error`: the scenario could not run, which says nothing about the behavior. */
  readonly status: "passed" | "failed" | "error";
  readonly title: string;
  readonly message?: string;
  readonly steps: ReadonlyArray<{ readonly step: string; readonly status: string }>;
  /** Absolute capture paths, in the order the scenario took them. */
  readonly captures: ReadonlyArray<string>;
  readonly videos: ReadonlyArray<string>;
}

/** Only a failed expectation shows the bug. A missing control or a dead app shows nothing. */
export function readSide(sha: string, outDir: string, report: E2EReport | undefined): SideResult {
  // The report also lists the tests the run did not select, with no attempts.
  const result = report?.run.results.find((candidate) => candidate.attempts.length > 0);
  const attempt = result?.attempts.at(-1);
  if (report === undefined || result === undefined || attempt === undefined) {
    const message = "e2e wrote no report: the app did not start, or no test was selected";
    return { sha, status: "error", title: "", message, steps: [], captures: [], videos: [] };
  }
  const files = (kind: string) =>
    (attempt.artifacts ?? []).flatMap((artifact) =>
      artifact.kind === kind && artifact.path !== undefined
        ? [NodePath.join(outDir, "results", artifact.path)]
        : [],
    );
  const error = attempt.error;
  return {
    sha,
    status:
      report.run.exitCode === 0
        ? "passed"
        : error?.code === "ASSERTION_FAILED"
          ? "failed"
          : "error",
    title: result.titlePath.join(" > "),
    ...(error === undefined ? {} : { message: `${error.code}: ${error.message}` }),
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
  NodePath.basename(path, ".png").replace(/^\d+-/, "").replaceAll("-", " ");

/** `link` maps a capture path to what the Markdown should point at, such as an uploaded URL. */
export function buildProof(base: SideResult, head: SideResult, link: (path: string) => string) {
  const baseSha = `\`${short(base.sha)}\``;
  const headSha = `\`${short(head.sha)}\``;
  const broken = base.status === "error" ? base : head.status === "error" ? head : undefined;
  const verdict =
    broken !== undefined
      ? `Not proven: the scenario could not run on ${broken === base ? `base ${baseSha}` : `head ${headSha}`} (${broken.message ?? "unknown error"}).`
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

const git = (args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();

/** Runs `run` in a checkout of `sha`: this one when it already is that commit, else a worktree. */
function withCheckout<A>(sha: string, run: (appDir: string) => A): A {
  const clean = git(["status", "--porcelain", "--untracked-files=no"]).length === 0;
  if (clean && git(["rev-parse", "HEAD"]) === sha) return run(REPO_ROOT);
  // Beside this checkout, not in the temp directory, so tooling resolves as it does here.
  const worktree = `${REPO_ROOT}-scenario-${short(sha)}`;
  git(["worktree", "add", "--quiet", "--detach", "--force", worktree, sha]);
  try {
    NodeChildProcess.execFileSync("vp", ["i"], { cwd: worktree, stdio: ["ignore", 2, 2] });
    return run(worktree);
  } finally {
    git(["worktree", "remove", "--force", worktree]);
  }
}

if (import.meta.main) {
  const { values, positionals } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      "upload-command": { type: "string" },
    },
  });
  const [scenario] = positionals;
  if (scenario === undefined || values.base === undefined) {
    console.error(
      'Usage: node scripts/prove-scenario.ts <scenario file> --base <rev> [--head <rev>] [--upload-command "<command>"]',
    );
    process.exit(2);
  }
  const scenarioPath = NodePath.resolve(scenario);
  // A proof left by an earlier run must not be read as this one's.
  for (const stale of ["proof.md", "proof.json"]) {
    NodeFS.rmSync(NodePath.join(SCRIPTS, ".e2e/prove", stale), { force: true });
  }
  const sides = (["base", "head"] as const).map((side) => {
    const sha = git([
      "rev-parse",
      "--verify",
      `${side === "base" ? values.base : values.head}^{commit}`,
    ]);
    const outDir = NodePath.join(SCRIPTS, ".e2e/prove", side);
    NodeFS.rmSync(outDir, { recursive: true, force: true });
    withCheckout(sha, (appDir) =>
      // The scenario and e2e come from this checkout; only the app comes from `appDir`.
      NodeChildProcess.spawnSync(
        NodePath.join(SCRIPTS, "node_modules/.bin/e2e"),
        ["run", scenarioPath, "--output", NodePath.relative(SCRIPTS, outDir)],
        {
          cwd: SCRIPTS,
          stdio: ["ignore", 2, 2],
          env: { ...process.env, T3_SCENARIO_APP_DIR: appDir, E2E_TELEMETRY_DISABLED: "1" },
        },
      ),
    );
    const reportPath = NodePath.join(outDir, "report.json");
    const report = NodeFS.existsSync(reportPath)
      ? (JSON.parse(NodeFS.readFileSync(reportPath, "utf8")) as E2EReport)
      : undefined;
    return readSide(sha, outDir, report);
  });
  const [base, head] = sides as [SideResult, SideResult];
  const captures = [...base.captures, ...head.captures];
  const links = new Map<string, string>();
  if (values["upload-command"] !== undefined && captures.length > 0) {
    const [command = "", ...args] = values["upload-command"].split(/\s+/).filter(Boolean);
    // A failed upload must not lose two finished runs: the proof then points at local files.
    try {
      const urls = NodeChildProcess.execFileSync(command, [...args, ...captures], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
      for (const [index, url] of urls.trim().split("\n").entries()) {
        const capture = captures[index];
        if (capture !== undefined) links.set(capture, url);
      }
    } catch {
      console.error("The upload command failed; the proof links local capture files.");
    }
  }
  const proveDir = NodePath.join(SCRIPTS, ".e2e/prove");
  const proof = buildProof(
    base,
    head,
    (path) => links.get(path) ?? NodePath.relative(proveDir, path),
  );
  NodeFS.writeFileSync(NodePath.join(proveDir, "proof.md"), proof.markdown);
  NodeFS.writeFileSync(
    NodePath.join(proveDir, "proof.json"),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  console.log(JSON.stringify(proof, null, 2));
  const couldNotRun = base.status === "error" || head.status === "error";
  process.exit(proof.failsOnBase && proof.passesOnHead ? 0 : couldNotRun ? 2 : 1);
}
