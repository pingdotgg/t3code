import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect, it } from "vite-plus/test";
import { gradePrContent, hasConventionalCommitPrefix } from "./grade.ts";

effectIt.live("rejects an empty case before requiring Codex or creating output", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-case-" });
    const outputDirectory = path.join(directory, "results");
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          path.join(import.meta.dirname, "run.ts"),
          "--model",
          "not-called",
          "--case",
          "",
          "--out",
          outputDirectory,
        ],
        { env: { ...process.env, CODEX_HOME: directory, PATH: "", Path: "" } },
      ),
    );
    const [exitCode, stderr] = yield* Effect.all(
      [
        child.exitCode,
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.stdout.pipe(Stream.runDrain),
      ],
      { concurrency: "unbounded" },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown --case");
    expect(yield* fs.exists(outputDirectory)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.each([
  {
    title: "Retire legacy model",
    body: "## Summary\n- Add retirement metadata.\n## Testing\n- Not run",
    passed: true,
  },
  {
    title: "Blocked: cannot access PR status",
    body: "Cannot start babysitting without GitHub access.",
    passed: false,
  },
  {
    title: "Retire legacy model",
    body: "Please provide the PR number so I can start babysitting.",
    passed: false,
  },
  { title: "Watch CI", body: "All checks passed.", passed: false },
  { title: "Retire legacy model", body: "All checks passed.", passed: false },
  {
    title: "Retire legacy model",
    body: "## Summary\n- Add a retirement date and successor.\n## Testing\n- All checks passed.",
    passed: true,
  },
])("grades $title", ({ title, body, passed }) => {
  expect(gradePrContent({ title, body })).toBe(passed);
});

it.each([
  { title: "feat(models): add retirement metadata", conventional: true },
  { title: "fix!: drop legacy models", conventional: true },
  { title: "Add retirement metadata", conventional: false },
  { title: "Retire: legacy models", conventional: false },
])("detects a Conventional Commit prefix in $title", ({ title, conventional }) => {
  expect(hasConventionalCommitPrefix(title)).toBe(conventional);
});
