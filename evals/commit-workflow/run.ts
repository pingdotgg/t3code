#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as CodexTextGeneration from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import {
  parseLogicalChangeUnits,
  summarizeLogicalChangeUnits,
  formatLogicalChangeUnitsForModel,
} from "../../apps/server/src/git/LogicalCommitPatch.ts";

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
  { id: "omitted-unit-correction", instructions: false },
  { id: "large-fixture-plan", instructions: false },
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
await using runtime = ManagedRuntime.make(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-commit-eval-state-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
);
const generation = await runtime.runPromise(
  CodexTextGeneration.makeCodexTextGeneration(Schema.decodeSync(CodexSettings)({})),
);
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
      if (fixture.id === "large-fixture-plan") {
        git("restore", "alpha.txt", "beta.txt");
        for (let index = 1; index <= 61; index++) {
          const filePath = NodePath.join(
            cwd,
            index <= 40
              ? `src/main/feature-${String(index).padStart(2, "0")}.php`
              : `src/test/resources/fixtures/case-${index}.php.txt`,
          );
          await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
          const lines = Array.from(
            { length: index === 1 ? 1500 : 15 },
            (_, line) => `    public function value${line}(): int { return ${index + line}; }`,
          );
          await NodeFSP.writeFile(
            filePath,
            `<?php\n// Concern ${index % 6}\nfinal class Example${index} {\n${lines.join("\n")}\n}\n`,
          );
        }
        git("add", "src");
      }
      const patch = git(
        "diff",
        ...(fixture.id === "large-fixture-plan" ? ["--cached"] : []),
        "--binary",
      );
      const units = parseLogicalChangeUnits(patch);
      const generationCwd = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "t3-commit-writer-"),
      );
      process.stdout.write(`${fixture.id} sample ${sample}: starting\n`);
      const instructions = fixture.instructions
        ? await NodeFSP.readFile(NodePath.join(cwd, ".t3code/commit-message.md"), "utf8")
        : "";
      let generated;
      try {
        generated = await runtime.runPromise(
          generation.generateCommitPlan({
            cwd: generationCwd,
            branch: "feature/eval",
            ...(fixture.id === "omitted-unit-correction"
              ? {
                  correction: {
                    error: `The generated commit plan omitted 1 change unit(s): ${units[1]?.id} beta.txt.`,
                    previousPlan: {
                      commits: [
                        {
                          subject: "Preserve alpha behavior",
                          body: "",
                          hunkIds: [units[0]?.id ?? ""],
                        },
                      ],
                    },
                  },
                }
              : {}),
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model,
              options: [{ id: "reasoningEffort", value: "low" }],
            },
            changeUnitSummary: summarizeLogicalChangeUnits(units),
            annotatedPatch: formatLogicalChangeUnitsForModel(units),
            policy: {
              kind: "custom",
              inferRepositoryConventions: false,
              commitInstructions: instructions,
            },
          }),
        );
      } finally {
        await NodeFSP.rm(generationCwd, { recursive: true, force: true });
      }
      const ids = generated.commits.flatMap((commit) => commit.hunkIds);
      const subjects = generated.commits.map((commit) => commit.subject);
      const preserved =
        git("rev-parse", "HEAD") === base &&
        git("diff", ...(fixture.id === "large-fixture-plan" ? ["--cached"] : []), "--binary") ===
          patch &&
        (fixture.id === "large-fixture-plan" ? git("diff") === "" : git("diff", "--cached") === "");
      const passed =
        preserved &&
        generated.commits.every(
          (commit) => commit.hunkIds.length > 0 && commit.subject.length > 0,
        ) &&
        JSON.stringify(ids.toSorted()) ===
          JSON.stringify(units.map((unit) => unit.id).toSorted()) &&
        (!fixture.instructions || subjects.every((subject) => subject.startsWith("EVAL:"))) &&
        (fixture.id !== "omitted-unit-correction" ||
          generated.commits.some(
            (commit) =>
              commit.subject === "Preserve alpha behavior" &&
              commit.hunkIds.includes(units[0]?.id ?? ""),
          ));
      await NodeFSP.writeFile(
        NodePath.join(output, `${fixture.id}-${sample}.json`),
        JSON.stringify(generated, null, 2),
      );
      results.push({ id: fixture.id, sample, model, subjects, preserved, passed });
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
