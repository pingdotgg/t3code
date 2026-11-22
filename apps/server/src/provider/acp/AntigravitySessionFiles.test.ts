// @effect-diagnostics nodeBuiltinImport:off -- fixtures write a native session database.
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  removeAntigravitySessionFiles,
  retireAntigravityRuntimeTempDirs,
  rewindAntigravitySession,
} from "./AntigravitySessionFiles.ts";

const SESSION_ID = "047c62f6-607b-44db-bfbe-f83b67e9e8b1";
const OTHER_SESSION_ID = "9b2b7a98-28db-4422-9f46-70e106319548";

const varint = (value: number): number[] => {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 0x80);
  }
  return [...bytes, value];
};
const protoField = (number: number, value: string | Uint8Array) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
};
const proto = (...parts: number[][]) => Uint8Array.from(parts.flat());

function encodeTrajectoryMetadata(input: {
  readonly sessionId?: string;
  readonly workspaceUris: ReadonlyArray<string>;
}) {
  return proto(
    ...input.workspaceUris.map((uri) => protoField(1, proto(protoField(1, uri)))),
    ...(input.sessionId === undefined ? [] : [protoField(6, input.sessionId)]),
    ...input.workspaceUris.map((uri) => protoField(7, uri)),
  );
}

function writeNativeSessionDb(dbPath: string, blob?: Uint8Array) {
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    database.exec("CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)");
    if (blob !== undefined) {
      database
        .prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)")
        .run("main", blob);
    }
  } finally {
    database.close();
  }
}

const makeNativeSessionFixture = Effect.fn("makeNativeSessionFixture")(function* (input: {
  readonly sessionId?: string;
  readonly workspacePaths: ReadonlyArray<string>;
  readonly metadataSessionId?: string;
  readonly corruptBlob?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-session-files-" });
  const profileDirectory = path.join(root, "profile");
  const acpDirectory = path.join(profileDirectory, "antigravity-acp");
  const conversations = path.join(acpDirectory, "conversations");
  const annotations = path.join(acpDirectory, "annotations");
  const sessionId = input.sessionId ?? SESSION_ID;
  const brain = path.join(acpDirectory, "brain", sessionId);
  const base = path.join(conversations, sessionId);
  const annotationFile = path.join(annotations, `${sessionId}.pbtxt`);

  yield* fs.makeDirectory(conversations, { recursive: true });
  yield* fs.makeDirectory(annotations, { recursive: true });
  yield* fs.makeDirectory(brain, { recursive: true });

  const blob = input.corruptBlob
    ? Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    : encodeTrajectoryMetadata({
        sessionId: input.metadataSessionId ?? sessionId,
        workspaceUris: input.workspacePaths.map((entry) => NodeURL.pathToFileURL(entry).href),
      });
  writeNativeSessionDb(`${base}.db`, blob);
  yield* fs.writeFileString(`${base}.db-wal`, "wal");
  yield* fs.writeFileString(`${base}.db-shm`, "shm");
  yield* fs.writeFileString(path.join(brain, "output.txt"), "artifact");
  yield* fs.writeFileString(annotationFile, "annotation");

  return { root, profileDirectory, base, brain, annotationFile, sessionId };
});

it.layer(NodeServices.layer)("removeAntigravitySessionFiles", (it) => {
  it.effect(
    "removes Antigravity 1.5+ session files without a .meta sidecar when the DB matches cwd",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-setup-" });
        const realCwd = yield* fs.realPath(cwd);
        const fixture = yield* makeNativeSessionFixture({
          workspacePaths: [realCwd, cwd],
        });

        yield* removeAntigravitySessionFiles({
          profileDirectory: fixture.profileDirectory,
          sessionId: fixture.sessionId,
          cwd,
        });

        expect(yield* fs.exists(`${fixture.base}.db`)).toBe(false);
        expect(yield* fs.exists(`${fixture.base}.db-wal`)).toBe(false);
        expect(yield* fs.exists(`${fixture.base}.db-shm`)).toBe(false);
        expect(yield* fs.exists(fixture.brain)).toBe(false);
        expect(yield* fs.exists(fixture.annotationFile)).toBe(false);
        expect(yield* fs.exists(path.dirname(fixture.base))).toBe(true);
      }),
  );

  it.effect("matches a symlinked temporary cwd against the canonical path stored in the DB", () =>
    Effect.gen(function* () {
      if (!symlinksSupported) return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-symlink-" });
      const targetCwd = path.join(parent, "real-temp");
      const linkCwd = path.join(parent, "link-temp");
      yield* fs.makeDirectory(targetCwd, { recursive: true });
      yield* fs.symlink(targetCwd, linkCwd);
      const fixture = yield* makeNativeSessionFixture({
        workspacePaths: [yield* fs.realPath(targetCwd)],
      });

      yield* removeAntigravitySessionFiles({
        profileDirectory: fixture.profileDirectory,
        sessionId: fixture.sessionId,
        cwd: linkCwd,
      });

      expect(yield* fs.exists(`${fixture.base}.db`)).toBe(false);
      expect(yield* fs.exists(fixture.brain)).toBe(false);
      expect(yield* fs.exists(fixture.annotationFile)).toBe(false);
    }),
  );

  it.effect("keeps a 1.5+ session DB whose metadata belongs to a different workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-project-" });
      const helperCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-helper-" });
      const fixture = yield* makeNativeSessionFixture({
        workspacePaths: [projectCwd],
      });

      yield* removeAntigravitySessionFiles({
        profileDirectory: fixture.profileDirectory,
        sessionId: fixture.sessionId,
        cwd: helperCwd,
      });

      expect(yield* fs.exists(`${fixture.base}.db`)).toBe(true);
      expect(yield* fs.exists(fixture.brain)).toBe(true);
      expect(yield* fs.exists(fixture.annotationFile)).toBe(true);
    }),
  );

  it.effect("keeps a 1.5+ session DB that also includes an additional workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const helperCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-helper-" });
      const attachmentsDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-attachments-" });
      const fixture = yield* makeNativeSessionFixture({
        workspacePaths: [helperCwd, attachmentsDir],
      });

      yield* removeAntigravitySessionFiles({
        profileDirectory: fixture.profileDirectory,
        sessionId: fixture.sessionId,
        cwd: helperCwd,
      });

      expect(yield* fs.exists(`${fixture.base}.db`)).toBe(true);
      expect(yield* fs.exists(fixture.brain)).toBe(true);
      expect(yield* fs.exists(fixture.annotationFile)).toBe(true);
    }),
  );

  it.effect(
    "keeps a 1.5+ session DB when its embedded session id mismatches or metadata is corrupt",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const helperCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-helper-" });
        const wrongId = yield* makeNativeSessionFixture({
          workspacePaths: [helperCwd],
          metadataSessionId: OTHER_SESSION_ID,
        });
        const corrupt = yield* makeNativeSessionFixture({
          workspacePaths: [helperCwd],
          corruptBlob: true,
        });

        yield* removeAntigravitySessionFiles({
          profileDirectory: wrongId.profileDirectory,
          sessionId: wrongId.sessionId,
          cwd: helperCwd,
        });
        yield* removeAntigravitySessionFiles({
          profileDirectory: corrupt.profileDirectory,
          sessionId: corrupt.sessionId,
          cwd: helperCwd,
        });

        expect(yield* fs.exists(`${wrongId.base}.db`)).toBe(true);
        expect(yield* fs.exists(`${corrupt.base}.db`)).toBe(true);
      }),
  );
});

it.layer(NodeServices.layer)("retireAntigravityRuntimeTempDirs", (it) => {
  it.effect("moves leftovers aside at once and deletes them, plus older retirees, later", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped();
      const runtimeTemp = path.join(parent, "abc123");
      const orphan = path.join(runtimeTemp, "run-orphan", "_MEI123");
      yield* fs.makeDirectory(orphan, { recursive: true });
      yield* fs.writeFileString(path.join(orphan, "payload.bin"), "stale");
      yield* fs.makeDirectory(path.join(parent, "abc123.old-unfinished", "runtime"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(parent, "other-instance"));

      const removeRetired = yield* retireAntigravityRuntimeTempDirs(runtimeTemp);
      expect(yield* fs.exists(runtimeTemp)).toBe(false);
      const retired = (yield* fs.readDirectory(parent)).filter((entry) =>
        entry.startsWith("abc123.old-"),
      );
      expect(retired).toHaveLength(2);

      yield* removeRetired;
      expect((yield* fs.readDirectory(parent)).toSorted()).toEqual(["other-instance"]);
    }),
  );

  it.effect(
    "deletes leftovers inline when they cannot be moved aside, such as on a full disk",
    () =>
      Effect.gen(function* () {
        const removed: Array<string> = [];
        const fs = FileSystem.makeNoop({
          exists: () => Effect.succeed(true),
          makeTempDirectory: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "makeTempDirectory",
                description: "ENOSPC",
              }),
            ),
          remove: (path) => Effect.sync(() => void removed.push(path)),
          readDirectory: () => Effect.succeed([]),
        });

        const removeRetired = yield* retireAntigravityRuntimeTempDirs(
          "/state/antigravity-tmp/abc123",
        ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        yield* removeRetired;
        expect(removed).toEqual(["/state/antigravity-tmp/abc123"]);
      }),
  );
});

const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const protoVarint = (number: number, value: number) => [...varint(number * 8), ...varint(value)];

/** Three native turns, whose prompts arrive at 1000s, 2000s and 3000s. */
const makeRewindFixture = Effect.fn("makeRewindFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-session-rewind-" });
  const acp = path.join(root, "antigravity-acp");
  const generated = path.join(acp, "brain", SESSION_ID, ".system_generated");
  const steps: ReadonlyArray<readonly [type: number, seconds: number, generation: number]> = [
    [USER_INPUT, 1000, 0],
    [PLANNER_RESPONSE, 1001, 0],
    [132, 1002, 0],
    [USER_INPUT, 2000, 1],
    [PLANNER_RESPONSE, 2001, 1],
    [USER_INPUT, 3000, 2],
    [PLANNER_RESPONSE, 3001, 2],
  ];
  yield* fs.makeDirectory(path.join(acp, "conversations"), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(path.join(acp, "conversations", `${SESSION_ID}.db`));
  try {
    database.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    database.prepare("INSERT INTO trajectory_meta VALUES (?, ?)").run("trajectory", SESSION_ID);
    for (const [idx, [type, seconds, generation]] of steps.entries()) {
      database
        .prepare("INSERT INTO steps VALUES (?, ?, ?)")
        .run(
          idx,
          type,
          proto(
            protoField(1, proto(protoVarint(1, seconds), protoVarint(2, 500_000_000))),
            protoField(20, proto(protoVarint(2, idx), protoVarint(3, generation))),
          ),
        );
    }
    for (const [run, lastStep] of [2, 4, 6].entries()) {
      database.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(run, proto());
      database
        .prepare("INSERT INTO executor_metadata VALUES (?, ?)")
        .run(run, proto(protoVarint(3, lastStep)));
    }
  } finally {
    database.close();
  }
  const transcript = steps.map((_, idx) => `{"step_index":${idx},"type":"STEP"}\n`).join("");
  for (const name of ["transcript", "transcript_full"]) {
    yield* fs.makeDirectory(path.join(generated, "logs", "chunks", name), { recursive: true });
    yield* fs.writeFileString(path.join(generated, "logs", `${name}.jsonl`), transcript);
    yield* fs.writeFileString(
      path.join(generated, "logs", "chunks", name, "00000000.jsonl"),
      transcript,
    );
  }
  for (const step of [2, 6]) {
    yield* fs.makeDirectory(path.join(generated, "steps", String(step)), { recursive: true });
    yield* fs.writeFileString(path.join(generated, "steps", String(step), "output.txt"), "output");
  }
  yield* fs.makeDirectory(path.join(generated, "logs", "media"), { recursive: true });
  for (const step of [1, 6]) {
    yield* fs.writeFileString(
      path.join(generated, "logs", "media", `step_${step}_media_0.jpg`),
      "",
    );
  }
  const read = () => {
    const database = new NodeSqlite.DatabaseSync(
      path.join(acp, "conversations", `${SESSION_ID}.db`),
      { readOnly: true },
    );
    try {
      const column = (sql: string) =>
        database
          .prepare(sql)
          .all()
          .map((row) => Object.values(row)[0]);
      return {
        steps: column("SELECT idx FROM steps ORDER BY idx"),
        generations: column("SELECT idx FROM gen_metadata ORDER BY idx"),
        runs: column("SELECT idx FROM executor_metadata ORDER BY idx"),
        trajectory: column("SELECT trajectory_id FROM trajectory_meta"),
      };
    } finally {
      database.close();
    }
  };
  return { profileDirectory: root, generated, read };
});

it.layer(NodeServices.layer)("rewindAntigravitySession", (it) => {
  it.effect("cuts the session and its brain files back to the turns before a time", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeRewindFixture();

      yield* rewindAntigravitySession({
        profileDirectory: fixture.profileDirectory,
        sessionId: SESSION_ID,
        before: DateTime.makeUnsafe(2500_000),
      });

      const after = fixture.read();
      expect(after).toMatchObject({ steps: [0, 1, 2, 3, 4], generations: [0, 1], runs: [0, 1] });
      expect(after.trajectory).not.toEqual(["trajectory"]);
      const kept = [0, 1, 2, 3, 4].map((idx) => `{"step_index":${idx},"type":"STEP"}\n`).join("");
      for (const name of ["transcript", "transcript_full"]) {
        const logs = path.join(fixture.generated, "logs");
        expect(yield* fs.readFileString(path.join(logs, `${name}.jsonl`))).toBe(kept);
        expect(yield* fs.readDirectory(path.join(logs, "chunks", name))).toEqual([
          "00000000.jsonl",
        ]);
        expect(yield* fs.readFileString(path.join(logs, "chunks", name, "00000000.jsonl"))).toBe(
          kept,
        );
      }
      expect(yield* fs.readDirectory(path.join(fixture.generated, "steps"))).toEqual(["2"]);
      expect(yield* fs.readDirectory(path.join(fixture.generated, "logs", "media"))).toEqual([
        "step_1_media_0.jpg",
      ]);
    }),
  );

  it.effect(
    "keeps a session no later prompt reached, and refuses one that would keep nothing",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeRewindFixture();
        const before = fixture.read();
        const rewind = (seconds: number) =>
          rewindAntigravitySession({
            profileDirectory: fixture.profileDirectory,
            sessionId: SESSION_ID,
            before: DateTime.makeUnsafe(seconds * 1000),
          });

        yield* rewind(4000);
        expect(fixture.read()).toEqual(before);
        const refused = yield* Effect.flip(rewind(500));
        expect(refused.message).toContain("holds none of the kept turns");
        expect(fixture.read()).toEqual(before);
      }),
  );
});
