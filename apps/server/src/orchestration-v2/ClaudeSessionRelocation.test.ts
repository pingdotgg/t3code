import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeSessionRelocation from "./ClaudeSessionRelocation.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const sessionId = "session-relocated";
const transcript = `${JSON.stringify({ type: "user", sessionId })}\n`;
const agentLine = '{"type":"assistant"}\n';

const repo = "/Users/me/repo";
const override = (name: string) => ({
  CLAUDE_CONFIG_DIR: "/config",
  CLAUDE_CODE_PROJECT_DIR_NAME: name,
});

it.each([
  ["/Users/me/Repo.v2", {}, "-Users-me-Repo-v2"],
  // Golden value from the SDK's own projectDirName (sdk.mjs `Fu`).
  [`/${"a".repeat(250)}`, {}, `-${"a".repeat(199)}-feo44x`],
  [repo, override("my_proj-1"), "my_proj-1"],
  [repo, { CLAUDE_CODE_PROJECT_DIR_NAME: "my_proj-1" }, "-Users-me-repo"],
  [repo, override("a/b"), "-Users-me-repo"],
  [repo, override("COM1"), "-Users-me-repo"],
  [repo, override("x".repeat(65)), "-Users-me-repo"],
] as const)("names Claude's project folder for %s with %o", (folder, environment, name) => {
  assert.equal(ClaudeSessionRelocation.claudeProjectDirName(folder, environment), name);
});

const errno = (code: string, pathOrDescriptor: string, method = "rename") =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor,
    cause: Object.assign(new Error(code), { code }),
  });

const threadId = ThreadId.make("thread:claude-relocation");
const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const providerThread = {
  id: ProviderThreadId.make("provider-thread:claude-relocation"),
  driver,
  providerInstanceId: instanceId,
};

const setup = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-relocation-" });
  const configDir = path.join(root, "config");
  const oldFolder = path.join(root, "repo-a");
  // Decomposed é: Claude names the folder from its NFC form on macOS.
  const newFolder = path.join(root, "cafe\u0301");
  yield* fs.makeDirectory(oldFolder);
  yield* fs.makeDirectory(newFolder);
  const relocatedCwd = (yield* fs.realPath(newFolder)).normalize("NFC");
  const projectDir = (folder: string) =>
    path.join(configDir, "projects", ClaudeSessionRelocation.claudeProjectDirName(folder, {}));
  const oldDir = projectDir((yield* fs.realPath(oldFolder)).normalize("NFC"));
  const newDir = projectDir(relocatedCwd);
  const oldSubs = path.join(oldDir, sessionId);
  const newSubs = path.join(newDir, sessionId);
  const agentFile = path.join(newSubs, "agent-1.jsonl");
  const oldFile = path.join(oldDir, `${sessionId}.jsonl`);
  const newFile = path.join(newDir, `${sessionId}.jsonl`);
  const record = `${JSON.stringify({ type: "relocated", sessionId, relocatedCwd })}\n`;
  const writes: Array<string | undefined> = [];
  yield* fs.makeDirectory(oldSubs, { recursive: true });
  yield* fs.writeFileString(oldFile, transcript);
  yield* fs.writeFileString(path.join(oldSubs, "agent-1.jsonl"), agentLine);
  const run = (fileSystem: FileSystem.FileSystem, committed = true) =>
    ClaudeSessionRelocation.relocateClaudeSessionStorage(threadId, {
      type: "provider-session.relocate-storage",
      driver,
      providerInstanceId: instanceId,
      providerThreadId: providerThread.id,
      nativeSessionId: sessionId,
      oldFolder,
      newFolder,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            providerInstances: { [instanceId]: { driver, config: { homePath: configDir } } },
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed({ providerThreads: [providerThread] }) as never,
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeIfProviderThreadUnchanged: ({ events: [event] }) =>
              Effect.sync(() => {
                if (event?.type === "provider-thread.updated")
                  writes.push(event.payload.nativeStorageFolder);
                return { committed, storedEvents: [] };
              }),
          }),
          IdAllocator.layer,
        ),
      ),
    );
  const expectLayout = Effect.fnUntraced(function* (
    transcriptAt: "old" | "new" | "none",
    subagentsAt: "old" | "new" | "none",
    tail = record,
    rows = 1,
  ) {
    assert.equal(yield* fs.exists(oldFile), transcriptAt === "old");
    assert.equal(yield* fs.exists(newFile), transcriptAt === "new");
    if (transcriptAt !== "none") {
      const file = transcriptAt === "old" ? oldFile : newFile;
      assert.equal(yield* fs.readFileString(file), `${transcript}${tail}`);
    }
    assert.equal(yield* fs.exists(oldSubs), subagentsAt === "old");
    const agent = yield* Effect.orElseSucceed(fs.readFileString(agentFile), () => "");
    assert.equal(agent, subagentsAt === "new" ? agentLine : "");
    assert.deepEqual(writes, Array(rows).fill(newFolder));
  });
  return { fs, record, run, expectLayout, oldDir, newDir, oldFile, newFile, oldSubs, newSubs };
});

it.effect("supersedes an occupant and a stale subagent folder in the new folder's storage", () =>
  Effect.gen(function* () {
    const { fs, newDir, newFile, newSubs, run, expectLayout } = yield* setup();
    assert.isTrue(newDir.endsWith("-caf-"));
    yield* fs.makeDirectory(newSubs, { recursive: true });
    yield* fs.writeFileString(`${newSubs}/stale.jsonl`, "stale\n");
    yield* fs.writeFileString(newFile, "occupant\n");

    yield* run(fs);

    yield* expectLayout("new", "new");
    assert.equal(yield* fs.readFileString(`${newFile}.superseded-0`), "occupant\n");
    assert.isTrue(yield* fs.exists(`${newSubs}.superseded-0`));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("copies across devices like Claude", () =>
  Effect.gen(function* () {
    const { fs, oldDir, oldSubs, newSubs, run, expectLayout } = yield* setup();
    yield* fs.chmod(oldSubs, 0o755);
    const crossDevice = FileSystem.FileSystem.of({
      ...fs,
      rename: (from, to) =>
        from.startsWith(oldDir) ? Effect.fail(errno("EXDEV", from)) : fs.rename(from, to),
    });

    yield* run(crossDevice);

    yield* expectLayout("new", "new");
    assert.equal((yield* fs.stat(newSubs)).mode & 0o777, 0o700);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("leaves a foreign or diskless session alone", () =>
  Effect.gen(function* () {
    const { fs, oldDir, newDir, newFile, run, expectLayout } = yield* setup();
    const foreign = `${JSON.stringify({ type: "user", sessionId: "another-session" })}\n`;
    yield* fs.remove(oldDir, { recursive: true });
    yield* fs.makeDirectory(newDir);
    yield* fs.writeFileString(newFile, foreign);
    assert.deepInclude(yield* Effect.flip(run(fs)), { path: newFile });
    assert.equal(yield* fs.readFileString(newFile), foreign);

    yield* fs.remove(newDir, { recursive: true });
    yield* run(fs);
    yield* expectLayout("none", "none", "");
    assert.isFalse(yield* fs.exists(newDir));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("retries an occupied rename when the destination cannot be set aside", () =>
  Effect.gen(function* () {
    const { fs, oldSubs, newSubs, run, expectLayout } = yield* setup();
    let occupied = true;
    const flaky = FileSystem.FileSystem.of({
      ...fs,
      rename: (from, to) => {
        if (from === newSubs) return Effect.fail(errno("EPERM", from));
        if (from === oldSubs && occupied) {
          occupied = false;
          return Effect.fail(errno("EEXIST", from));
        }
        return fs.rename(from, to);
      },
    });

    yield* run(flaky);

    yield* expectLayout("new", "new");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { name: "writes the new folder once the transcript moved" },
  { name: "fails when the provider thread changed", committed: false },
  { name: "denied transcript rename", at: "transcript", fault: "denied" },
  { name: "denied subagent rename", at: "subagents", fault: "denied" },
  { name: "denied record append", at: "record", fault: "denied" },
  { name: "lost after the transcript rename", at: "subagents", fault: "lost" },
  { name: "lost before the relocated record", at: "record", fault: "lost" },
  { name: "lost partway through the record", at: "record", fault: "lost", written: 20 },
  { name: "lost before the record's newline", at: "record", fault: "lost", written: -1 },
])(
  "relocates and records the storage folder: $name",
  ({ committed = true, at, fault, written = 0 }) =>
    Effect.gen(function* () {
      const { fs, oldFile, oldSubs, record, run, expectLayout } = yield* setup();
      let faulty = at !== undefined;
      const fail = (file: string, method?: string) =>
        fault === "lost" ? Effect.die("process lost") : Effect.fail(errno("EACCES", file, method));
      const faultedRename =
        at === "transcript" ? oldFile : at === "subagents" ? oldSubs : undefined;
      const flaky = FileSystem.FileSystem.of({
        ...fs,
        rename: (from, to) => (faulty && from === faultedRename ? fail(from) : fs.rename(from, to)),
        writeFileString: (file, data, options) =>
          faulty && at === "record"
            ? fs
                .writeFileString(file, data.slice(0, written), options)
                .pipe(Effect.andThen(fail(file, "open")))
            : fs.writeFileString(file, data, options),
      });
      const outcome = Effect.exit(run(flaky, committed));
      if (faulty) {
        assert.equal((yield* outcome)._tag, "Failure");
        yield* expectLayout(
          at === "transcript" ? "old" : "new",
          at === "record" ? "new" : "old",
          at === "record" ? record.slice(0, written) : "",
          0,
        );
        faulty = false;
      }

      assert.equal((yield* outcome)._tag, committed ? "Success" : "Failure");
      const fragment = written === 0 ? "" : `${record.slice(0, written)}\n`;
      const tail = `${fragment}${fragment === record ? "" : record}`;
      yield* expectLayout("new", "new", tail);
      yield* outcome;
      yield* expectLayout("new", "new", tail, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
);
