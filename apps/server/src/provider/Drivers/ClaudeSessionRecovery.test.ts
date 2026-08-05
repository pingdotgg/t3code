import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { recoverClaudeSession } from "./ClaudeSessionRecovery.ts";
const encodeTranscriptEntry = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String, cwd: Schema.String })),
);

describe("recoverClaudeSession", () => {
  it.effect("copies an orphaned transcript into the current project directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const configDirectory = path.join(root, ".claude");
      const projectsDirectory = path.join(configDirectory, "projects");
      const sourceDirectory = path.join(projectsDirectory, "deleted-worktree");
      const cwd = path.join(root, "project");
      const missingCwd = path.join(root, "deleted-worktree", "apps", "server");
      const sessionId = "11111111-1111-4111-8111-111111111111";
      const sourceTranscript = path.join(sourceDirectory, `${sessionId}.jsonl`);
      const transcript = `${encodeTranscriptEntry({ type: "user", cwd: missingCwd })}\n`;

      yield* fileSystem.makeDirectory(sourceDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.writeFileString(sourceTranscript, transcript);

      const result = yield* recoverClaudeSession({
        environment: { CLAUDE_CONFIG_DIR: configDirectory },
        cwd,
        sessionId,
      });
      const targetTranscript = path.join(
        projectsDirectory,
        cwd.replace(/[^a-zA-Z0-9]/g, "-"),
        `${sessionId}.jsonl`,
      );

      assert.equal(result, "rehomed");
      assert.equal(yield* fileSystem.readFileString(targetTranscript), transcript);
      assert.equal(yield* fileSystem.readFileString(sourceTranscript), transcript);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a transcript in a live working directory in place", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const configDirectory = path.join(root, ".claude");
      const sourceDirectory = path.join(configDirectory, "projects", "live-worktree");
      const cwd = path.join(root, "project");
      const liveCwd = path.join(root, "live-worktree");
      const sessionId = "22222222-2222-4222-8222-222222222222";

      yield* fileSystem.makeDirectory(sourceDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(liveCwd, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(sourceDirectory, `${sessionId}.jsonl`),
        `${encodeTranscriptEntry({ type: "assistant", cwd: liveCwd })}\n`,
      );

      const result = yield* recoverClaudeSession({
        environment: { CLAUDE_CONFIG_DIR: configDirectory },
        cwd,
        sessionId,
      });

      assert.equal(result, "available");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores non-directory entries in the projects directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const configDirectory = path.join(root, ".claude");
      const projectsDirectory = path.join(configDirectory, "projects");
      const sourceDirectory = path.join(projectsDirectory, "deleted-worktree");
      const cwd = path.join(root, "project");
      const missingCwd = path.join(root, "deleted-worktree");
      const sessionId = "44444444-4444-4444-8444-444444444444";

      yield* fileSystem.makeDirectory(sourceDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.writeFileString(path.join(projectsDirectory, ".DS_Store"), "");
      yield* fileSystem.writeFileString(
        path.join(sourceDirectory, `${sessionId}.jsonl`),
        `${encodeTranscriptEntry({ type: "user", cwd: missingCwd })}\n`,
      );

      const result = yield* recoverClaudeSession({
        environment: { CLAUDE_CONFIG_DIR: configDirectory },
        cwd,
        sessionId,
      });

      assert.equal(result, "rehomed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rehomes when the working directory path is now a file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const configDirectory = path.join(root, ".claude");
      const sourceDirectory = path.join(configDirectory, "projects", "replaced-worktree");
      const cwd = path.join(root, "project");
      const replacedCwd = path.join(root, "replaced-worktree");
      const sessionId = "77777777-7777-4777-8777-777777777777";

      yield* fileSystem.makeDirectory(sourceDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.writeFileString(replacedCwd, "");
      yield* fileSystem.writeFileString(
        path.join(sourceDirectory, `${sessionId}.jsonl`),
        `${encodeTranscriptEntry({ type: "user", cwd: replacedCwd })}\n`,
      );

      const result = yield* recoverClaudeSession({
        environment: { CLAUDE_CONFIG_DIR: configDirectory },
        cwd,
        sessionId,
      });

      assert.equal(result, "rehomed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rehomes the most recently modified orphaned transcript", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const configDirectory = path.join(root, ".claude");
      const projectsDirectory = path.join(configDirectory, "projects");
      const cwd = path.join(root, "project");
      const sessionId = "88888888-8888-4888-8888-888888888888";
      const olderDirectory = path.join(projectsDirectory, "aaa-old-worktree");
      const newerDirectory = path.join(projectsDirectory, "zzz-new-worktree");

      yield* fileSystem.makeDirectory(olderDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(newerDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(olderDirectory, `${sessionId}.jsonl`),
        `${encodeTranscriptEntry({ type: "user", cwd: path.join(root, "gone-old") })}\n`,
      );
      yield* fileSystem.writeFileString(
        path.join(newerDirectory, `${sessionId}.jsonl`),
        `${encodeTranscriptEntry({ type: "user", cwd: path.join(root, "gone-new") })}\n`,
      );
      yield* fileSystem.utimes(path.join(olderDirectory, `${sessionId}.jsonl`), 1_000, 1_000);

      const result = yield* recoverClaudeSession({
        environment: { CLAUDE_CONFIG_DIR: configDirectory },
        cwd,
        sessionId,
      });

      assert.equal(result, "rehomed");
      const rehomed = yield* fileSystem.readFileString(
        path.join(projectsDirectory, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`),
      );
      assert.equal(rehomed.includes("gone-new"), true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves an undecodable transcript alone rather than rehoming it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const configDirectory = path.join(root, ".claude");
      const sourceDirectory = path.join(configDirectory, "projects", "unknown-worktree");
      const cwd = path.join(root, "project");
      const sessionId = "66666666-6666-4666-8666-666666666666";

      yield* fileSystem.makeDirectory(sourceDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(sourceDirectory, `${sessionId}.jsonl`),
        "not json\n",
      );

      const result = yield* recoverClaudeSession({
        environment: { CLAUDE_CONFIG_DIR: configDirectory },
        cwd,
        sessionId,
      });

      assert.equal(result, "missing");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a missing transcript when no project holds the session", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const configDirectory = path.join(root, ".claude");
      const otherDirectory = path.join(configDirectory, "projects", "other-project");
      const cwd = path.join(root, "project");

      yield* fileSystem.makeDirectory(otherDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(otherDirectory, "99999999-9999-4999-8999-999999999999.jsonl"),
        `${encodeTranscriptEntry({ type: "user", cwd })}\n`,
      );

      const result = yield* recoverClaudeSession({
        environment: { CLAUDE_CONFIG_DIR: configDirectory },
        cwd,
        sessionId: "55555555-5555-4555-8555-555555555555",
      });

      assert.equal(result, "missing");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a missing transcript", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const result = yield* recoverClaudeSession({
        environment: { CLAUDE_CONFIG_DIR: root },
        cwd: root,
        sessionId: "33333333-3333-4333-8333-333333333333",
      });

      assert.equal(result, "missing");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
