import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CheckpointRef, VcsProcessExitError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import * as GitxVcsDriver from "./GitxVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const okOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const makeMockProcessLayer = (
  handler: (input: VcsProcess.VcsProcessInput) => VcsProcess.VcsProcessOutput,
) =>
  GitxVcsDriver.layerVcs.pipe(
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => Effect.succeed(handler(input)),
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const layerGitxContract = makeMockProcessLayer(() => okOutput(""));

runVcsDriverContractSuite<FileSystem.FileSystem | Path.Path, PlatformError.PlatformError>({
  name: "GitX",
  kind: "gitx",
  layer: layerGitxContract,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const gitxDir = path.join(cwd, ".gitx");
        yield* fileSystem.makeDirectory(gitxDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(gitxDir, "config.json"),
          JSON.stringify({
            author: { name: "Test", email: "test@gitx.local" },
            default_branch: "master",
            active_workspace: "default",
            colocated: false,
          }),
        );
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitxignore"), `${pattern}\n`);
      }),
  },
});

describe("GitxVcsDriver parsers", () => {
  it("parses gitx remote list output", () => {
    assert.deepStrictEqual(GitxVcsDriver.parseGitxRemoteListOutput("No remotes configured.\n"), []);

    const remotes = GitxVcsDriver.parseGitxRemoteListOutput(
      [
        "origin\thttp://127.0.0.1:7878/acme/app (owner=acme, repo=app) [token]",
        "backup\thttps://gitx.example.com/acme/mirror (owner=acme, repo=mirror)",
      ].join("\n"),
    );

    assert.deepStrictEqual(remotes, [
      {
        name: "origin",
        url: "http://127.0.0.1:7878/acme/app",
        pushUrl: Option.none(),
        isPrimary: true,
      },
      {
        name: "backup",
        url: "https://gitx.example.com/acme/mirror",
        pushUrl: Option.none(),
        isPrimary: false,
      },
    ]);
  });

  it("parses gitx status output for clean and dirty repositories", () => {
    const clean = GitxVcsDriver.parseGitxStatusOutput(
      [
        "Workspace:  default (@)",
        "ChangeId:   abc123def456 (abc123def4560000)",
        "Revision:   9f8e7d6c5b4a",
        "Visibility: public",
        "Description: (no description)",
        "",
        "Changes vs parent:",
        "  (no changes)",
      ].join("\n"),
    );
    assert.deepStrictEqual(clean, { revision: "9f8e7d6c5b4a", clean: true });

    const dirty = GitxVcsDriver.parseGitxStatusOutput(
      [
        "Workspace:  default (@)",
        "Revision:   112233445566",
        "",
        "Changes vs parent:",
        "  M [public] src/index.ts",
      ].join("\n"),
    );
    assert.deepStrictEqual(dirty, { revision: "112233445566", clean: false });
  });

  it("parses latest operation id from gitx op log", () => {
    assert.equal(GitxVcsDriver.parseGitxOpLogLatestId("Operation log is empty.\n"), null);
    assert.equal(
      GitxVcsDriver.parseGitxOpLogLatestId(
        '9a8b7c6d 2026-11-25 20:00:00 UTC Snapshot { workspace: "default" } — Snapshot working copy\n',
      ),
      "9a8b7c6d",
    );
  });

  it("formats gitx unified diff into git-compatible patches and numstat", () => {
    const rawDiff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
      "--- a/nested/skip.ts",
      "+++ b/nested/skip.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const sections = GitxVcsDriver.parseGitxUnifiedDiffSections(rawDiff);
    assert.equal(sections.length, 3);
    assert.equal(sections[0]?.additions, 2);
    assert.equal(sections[0]?.deletions, 1);

    const patch = GitxVcsDriver.formatGitxPatch(rawDiff, { excludePaths: ["nested"] });
    assert.include(patch, "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n");
    assert.include(patch, "Binary files a/assets/logo.png and b/assets/logo.png differ\n");
    assert.notInclude(patch, "nested/skip.ts");

    const numstat = GitxVcsDriver.formatGitxNumstat(rawDiff, {
      filePaths: ["src/app.ts", "assets/logo.png"],
    });
    assert.equal(numstat, "2\t1\tsrc/app.ts\0-\t-\tassets/logo.png\0");
    assert.equal(GitxVcsDriver.formatGitxPatch("(no differences)\n"), "");
  });
});

describe("GitxVcsDriver operations", () => {
  it.effect("detects linked GitX workspaces via .gitx/workspace.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gitx-ws-" });
      const primaryGitx = path.join(root, "primary", ".gitx");
      const linkedWorkspace = path.join(root, "agent-1");
      yield* fs.makeDirectory(primaryGitx, { recursive: true });
      yield* fs.makeDirectory(path.join(linkedWorkspace, ".gitx"), { recursive: true });
      yield* fs.writeFileString(
        path.join(linkedWorkspace, ".gitx", "workspace.json"),
        JSON.stringify({ gitx_dir: primaryGitx, workspace: "agent-1" }),
      );

      const driver = yield* VcsDriver.VcsDriver;
      const detected = yield* driver.detectRepository(linkedWorkspace);
      assert.equal(detected?.kind, "gitx");
      assert.equal(detected?.rootPath, path.resolve(linkedWorkspace));
      assert.equal(detected?.metadataPath, primaryGitx);
    }).pipe(Effect.provide(layerGitxContract)),
  );

  it.effect("passes --colocate when initializing inside an existing Git directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const standalone = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gitx-init-" });
      const colocated = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gitx-colocate-" });
      yield* fs.makeDirectory(path.join(colocated, ".git"));

      const invocations: Array<ReadonlyArray<string>> = [];
      const layer = makeMockProcessLayer((input) => {
        invocations.push(input.args);
        return okOutput("");
      });

      yield* Effect.gen(function* () {
        const driver = yield* VcsDriver.VcsDriver;
        yield* driver.initRepository({ cwd: standalone, kind: "gitx" });
        yield* driver.initRepository({ cwd: colocated, kind: "gitx" });
      }).pipe(Effect.provide(layer));

      assert.deepStrictEqual(invocations, [["init"], ["init", "--colocate"]]);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("lists configured GitX remotes and surfaces non-zero exits", () =>
    Effect.gen(function* () {
      const layer = makeMockProcessLayer((input) =>
        input.cwd === "/broken"
          ? {
              ...okOutput(""),
              exitCode: ChildProcessSpawner.ExitCode(1),
              stderr: "not inside a gitx repository",
            }
          : okOutput("origin\thttp://127.0.0.1:7878/acme/app (owner=acme, repo=app)\n"),
      );

      const ok = yield* VcsDriver.VcsDriver.pipe(
        Effect.flatMap((driver) => driver.listRemotes("/repo")),
        Effect.provide(layer),
      );
      assert.equal(ok.remotes.length, 1);
      assert.equal(ok.remotes[0]?.name, "origin");
      assert.equal(ok.remotes[0]?.url, "http://127.0.0.1:7878/acme/app");
      assert.equal(ok.remotes[0]?.isPrimary, true);

      const err = yield* VcsDriver.VcsDriver.pipe(
        Effect.flatMap((driver) => driver.listRemotes("/broken")),
        Effect.provide(layer),
        Effect.flip,
      );
      assert.instanceOf(err, VcsProcessExitError);
    }),
  );

  it.effect("captures, diffs, restores, and deletes GitX checkpoints", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gitx-cp-" });
      yield* fs.makeDirectory(path.join(repoDir, ".gitx"), { recursive: true });
      yield* fs.writeFileString(path.join(repoDir, ".gitx", "config.json"), "{}\n");

      let step = 0;
      const restoredOps: string[] = [];
      const layer = makeMockProcessLayer((input) => {
        const [sub, ...rest] = input.args;
        if (sub === "status") {
          return step === 0
            ? okOutput("Revision:   rev0001\nChanges vs parent:\n  (no changes)\n")
            : okOutput("Revision:   rev0002\nChanges vs parent:\n  M [public] hello.ts\n");
        }
        if (sub === "op" && rest[0] === "log") {
          return okOutput(
            step === 0
              ? "op000001 2026-11-25 20:00:00 UTC Init — Init\n"
              : "op000002 2026-11-25 20:01:00 UTC Snapshot — Snapshot\n",
          );
        }
        if (sub === "op" && rest[0] === "restore" && rest[1]) {
          restoredOps.push(rest[1]);
          return okOutput(`Restored operation '${rest[1]}'\n`);
        }
        if (sub === "diff") {
          return okOutput(
            "--- a/hello.ts\n+++ b/hello.ts\n@@ -1 +1,2 @@\n const a = 1;\n+const b = 2;\n",
          );
        }
        return okOutput("");
      });

      yield* Effect.gen(function* () {
        const driver = yield* VcsDriver.VcsDriver;
        const ref0 = CheckpointRef.make("refs/t3/checkpoints/t1/turn/0");
        const ref1 = CheckpointRef.make("refs/t3/checkpoints/t1/turn/1");

        assert.equal(yield* driver.checkpoints.resolveCleanHead(repoDir), "rev0001");
        assert.equal(
          yield* driver.checkpoints.captureCheckpoint({ cwd: repoDir, checkpointRef: ref0 }),
          null,
        );
        assert.equal(
          yield* driver.checkpoints.hasCheckpointRef({ cwd: repoDir, checkpointRef: ref0 }),
          true,
        );

        step = 1;
        assert.equal(yield* driver.checkpoints.resolveCleanHead(repoDir), null);
        const range = yield* driver.checkpoints.captureCheckpoint({
          cwd: repoDir,
          checkpointRef: ref1,
          previousCheckpointRef: ref0,
        });
        assert.equal(range?.from, "rev0001");
        assert.equal(range?.to, "rev0002");
        assert.equal(range?.unchanged, false);

        const patch = yield* driver.checkpoints.diffCheckpoints({
          cwd: repoDir,
          fromCheckpointRef: ref0,
          toCheckpointRef: ref1,
          ignoreWhitespace: false,
        });
        assert.include(patch, "diff --git a/hello.ts b/hello.ts\n");
        assert.include(patch, "+const b = 2;");

        const numstat = yield* driver.checkpoints.diffCheckpoints({
          cwd: repoDir,
          fromCheckpointRef: ref0,
          toCheckpointRef: ref1,
          ignoreWhitespace: false,
          format: "numstat",
        });
        assert.equal(numstat, "1\t0\thello.ts\0");

        assert.equal(
          yield* driver.checkpoints.listAuthoredPaths({
            cwd: repoDir,
            fromCheckpointRef: ref0,
            toCheckpointRef: ref1,
          }),
          null,
        );

        assert.equal(
          yield* driver.checkpoints.restoreCheckpoint({ cwd: repoDir, checkpointRef: ref0 }),
          true,
        );
        assert.deepStrictEqual(restoredOps, ["op000001"]);

        yield* driver.checkpoints.deleteCheckpointRefs({
          cwd: repoDir,
          checkpointRefs: [ref0, ref1],
        });
        assert.equal(
          yield* driver.checkpoints.hasCheckpointRef({ cwd: repoDir, checkpointRef: ref0 }),
          false,
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
