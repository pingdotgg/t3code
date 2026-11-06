#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { CommandId, ThreadId } from "@t3tools/contracts";
import { buildCommitWorkflowPrompt } from "../../apps/server/src/git/commitWorkflowPrompt.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string" },
    out: { type: "string" },
    baseline: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
  },
});
if (!values.model || !values.out) throw new Error("Use --model <model> --out <directory>.");
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be positive.");
const fixtures = [
  { id: "missing-instructions", instructions: false },
  { id: "present-instructions", instructions: true },
].filter((fixture) => values.case === undefined || fixture.id === values.case);
if (fixtures.length === 0) throw new Error("Unknown case.");
const output = NodePath.resolve(values.out);
await NodeFSP.mkdir(output, { recursive: true });
if (values.baseline) {
  const baseline = JSON.parse(await NodeFSP.readFile(values.baseline, "utf8")) as unknown;
  await NodeFSP.writeFile(
    NodePath.join(output, "baseline.json"),
    JSON.stringify(baseline, null, 2),
  );
}
const results = [];
const model = values.model;
for (const fixture of fixtures) {
  for (let sample = 0; sample < samples; sample++) {
    const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-commit-eval-"));
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    try {
      git("init", "-b", "feature/eval");
      git("config", "user.name", "Eval");
      git("config", "user.email", "eval@example.test");
      git("config", "commit.gpgsign", "false");
      await NodeFSP.writeFile(NodePath.join(cwd, "alpha.txt"), "alpha\n");
      await NodeFSP.writeFile(NodePath.join(cwd, "beta.txt"), "beta\n");
      await NodeFSP.writeFile(NodePath.join(cwd, "AGENTS.md"), "Preserve both text files.\n");
      if (fixture.instructions) {
        await NodeFSP.mkdir(NodePath.join(cwd, ".t3code"));
        await NodeFSP.writeFile(
          NodePath.join(cwd, ".t3code/commit-message.md"),
          "Start every commit subject with EVAL:.\n",
        );
      }
      git("add", ".");
      git("commit", "-m", "Initial fixture");
      const base = git("rev-parse", "HEAD");
      await NodeFSP.writeFile(NodePath.join(cwd, "alpha.txt"), "alpha\nindependent alpha change\n");
      await NodeFSP.writeFile(NodePath.join(cwd, "beta.txt"), "beta\nindependent beta change\n");
      const prompt = buildCommitWorkflowPrompt(
        {
          commandId: CommandId.make("eval"),
          threadId: ThreadId.make("eval"),
          cwd,
          expectedBranch: "feature/eval",
          scope: { type: "working_tree" },
        },
        { mode: "repo_conventions", customInstructions: "", followChangeRequestTemplates: true },
      );
      const log = NodePath.join(output, `${fixture.id}-${sample}.ndjson`);
      const transcript = NodeFS.createWriteStream(log);
      process.stdout.write(`${fixture.id} sample ${sample}: starting\n`);
      const exitCode = await new Promise<number | null>((complete, reject) => {
        const child = NodeChildProcess.spawn(
          "codex",
          [
            "exec",
            "--model",
            model,
            "--ephemeral",
            "--json",
            "--dangerously-bypass-approvals-and-sandbox",
            "-C",
            cwd,
            "-",
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        child.stdout.pipe(transcript, { end: false });
        child.stderr.pipe(transcript, { end: false });
        child.on("error", reject);
        child.on("close", (code) => transcript.end(() => complete(code)));
        child.stdin.end(prompt);
      });
      const subjects = git("log", "--format=%s", `${base}..HEAD`).split("\n").filter(Boolean);
      const preserved =
        (await NodeFSP.readFile(NodePath.join(cwd, "alpha.txt"), "utf8")) ===
          "alpha\nindependent alpha change\n" &&
        (await NodeFSP.readFile(NodePath.join(cwd, "beta.txt"), "utf8")) ===
          "beta\nindependent beta change\n";
      const changedPaths = git("diff", "--name-only", base, "HEAD").split("\n").sort();
      const passed =
        exitCode === 0 &&
        subjects.length > 0 &&
        preserved &&
        JSON.stringify(changedPaths) === JSON.stringify(["alpha.txt", "beta.txt"]) &&
        git("status", "--porcelain") === "" &&
        git("branch", "--show-current") === "feature/eval" &&
        (!fixture.instructions || subjects.every((subject) => subject.startsWith("EVAL:")));
      results.push({ id: fixture.id, sample, model, exitCode, subjects, preserved, passed });
      await NodeFSP.writeFile(
        NodePath.join(output, "results.json"),
        JSON.stringify(results, null, 2),
      );
      process.stdout.write(`${fixture.id} sample ${sample}: ${passed ? "PASS" : "FAIL"}\n`);
    } finally {
      await NodeFSP.rm(cwd, { recursive: true, force: true });
    }
  }
}
const cases = [];
for (const fixture of fixtures) {
  const rows = results.filter((row) => row.id === fixture.id);
  cases.push({
    id: fixture.id,
    passed: rows.filter((row) => !row.passed).length < Math.ceil(rows.length / 2),
  });
}
await NodeFSP.writeFile(NodePath.join(output, "cases.json"), JSON.stringify(cases, null, 2));
process.exitCode = cases.every((fixture) => fixture.passed) ? 0 : 1;
process.stdout.write(
  `${results.filter((row) => row.passed).length}/${results.length} passed. Paid CLI calls: ${results.length}; cost is not reported by the CLI.\n`,
);
