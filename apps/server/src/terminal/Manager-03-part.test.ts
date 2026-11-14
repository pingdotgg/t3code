import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalOpenInput,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  TerminalProviderInstanceNotFoundError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as TerminalManager from "./Manager.ts";
import { terminalOutputStream } from "./OutputProtocol.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { FakePtyAdapter, GatedPtyAdapter, createManager, encodeUnknownJson, historyLogPath, layerWithHostPlatform, openInput, publishPastOutputBudget } from "./Manager-part2.testkit.ts";

vi.mock("effect/SynchronizedRef", async (importOriginal) => {
  const original = await importOriginal<typeof SynchronizedRef>();
  return { ...original, make: vi.fn(original.make) };
});

// The server omits DOM types, which include TypeScript's WebAssembly declarations.




import { retainedHistory } from "./Manager-fixtures.testkit.ts";
it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    ProcessRunner.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  ),
  { excludeTestServices: true },
)("TerminalManager", (it) => {
  it.effect("bounds persisted and attached history without truncating live output", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager(5, { historyByteLimit: 10 });
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const writes = ["a".repeat(32), "😀\rEND"];
      const process = ptyAdapter.processes[0]!;
      for (const text of writes) process.emitData(text);
      yield* manager.close({ threadId: "thread-1" });
      expect(yield* readFileString(yield* historyLogPath(logsDir))).toBe("aa😀\rEND");

      const reopened = yield* manager.open(openInput());
      const events = yield* Ref.get(attachEvents);
      expect(events.filter((event) => event.type === "output").map((event) => event.data)).toEqual(
        writes,
      );
      const snapshot = events.filter((event) => event.type === "snapshot").at(-1)?.snapshot;
      expect(snapshot?.history).toBe("aa😀\rEND");
      expect(snapshot?.sequence).toBe(reopened.sequence);
    }),
  );
  it.effect("releases delivered output while the process queue stays busy", () =>
    Effect.gen(function* () {
      // Observe retained payloads, since delivery and bounded history alone cannot detect a leak.
      let readState: Effect.Effect<unknown> = Effect.void;
      const makeRef = vi.mocked(SynchronizedRef.make).getMockImplementation()!;
      using _capture = vi.spyOn(SynchronizedRef, "make").mockImplementation(<A>(value: A) =>
        makeRef(value).pipe(
          Effect.tap((ref) =>
            Effect.sync(() => {
              if (typeof value === "object" && value !== null && "sessions" in value) {
                readState = SynchronizedRef.get(ref);
              }
            }),
          ),
        ),
      );
      const { manager, ptyAdapter } = yield* createManager(5, { historyByteLimit: 1024 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const measured = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined));
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      const chunkBytes = 64 * 1024;
      const chunkCount = 256;
      let delivered = 0;
      const unsubscribe = yield* manager.subscribe((event) =>
        Effect.gen(function* () {
          if (event.type !== "output") return;
          delivered += 1;
          expect(event.data).toBe(
            delivered === 1
              ? "start"
              : (delivered === 2
                  ? "queued-a"
                  : delivered === 3
                    ? "queued-b"
                    : `${delivered - 3}`
                ).padEnd(chunkBytes, "x"),
          );
          if (delivered === 1) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          if (delivered === chunkCount) {
            yield* Deferred.succeed(measured, undefined);
            yield* Deferred.await(finish);
          } else if (delivered < chunkCount) {
            process.emitData(`${delivered}`.padEnd(chunkBytes, "x"));
          } else if (delivered === chunkCount + 2) {
            yield* Deferred.succeed(drained, undefined);
          }
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      process.emitData("start");
      yield* Deferred.await(entered);
      process.emitData("queued-a".padEnd(chunkBytes, "x"));
      process.emitData("queued-b".padEnd(chunkBytes, "x"));
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(measured);

      const state = (yield* readState) as {
        sessions: ReadonlyMap<
          string,
          { pendingProcessEvents: ReadonlyArray<{ data?: string } | undefined> }
        >;
      };
      const retained = [...state.sessions.values()].flatMap(
        (session) => session.pendingProcessEvents,
      );
      const retainedBytes = retained.reduce(
        (bytes, event) => bytes + (event?.data?.length ?? 0),
        0,
      );
      expect(delivered).toBe(chunkCount);
      expect(retainedBytes).toBeLessThanOrEqual(2 * chunkBytes);
      expect(retained.length).toBeLessThanOrEqual(4);
      yield* Deferred.succeed(finish, undefined);
      yield* Deferred.await(drained);
    }),
  );
  it.effect("retains plain Unicode and control characters around a split query", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      // Mojibake like "â€\u009d" (for ”) carries C1 code points that libghostty prints as text.
      const before = "café\t界🙂\u0007\u009c\u0085 â€\u009d Ð\u0090 \u009e\u009f\u009b6n";
      const after = "e\u0301\r\n";

      process.emitData(before);
      process.emitData("\u001b[5");
      process.emitData(`n${after}`);
      yield* manager.close({ threadId: "thread-1" });

      expect((yield* manager.open(openInput())).history).toBe(before + after);
    }),
  );
  it.effect("strips replayable CSI and DCS traffic while preserving setters", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      process.emitData("\u001b[?2026$p\u001b[?2026;2$y\u001b[>q\u001b[?u\u001b[?31u");
      process.emitData("\u001bP$q m\u001b\\\u001bP1$r0m\u001b\\");
      process.emitData("\u001bP+q544e\u001b\\\u001bP1+r544e=1b\u001b\\");
      process.emitData('\u001b[!p\u001b["p\u001b[4 q\u001b[u');
      process.emitData("\u001b]0;x\u001b\u001b[?2026$p");
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      expect(
        reopened.history.startsWith(
          'prompt \u001b[!p\u001b["p\u001b[4 q\u001b[u\u001b]0;x\u001bdone\n',
        ),
      ).toBe(true);
    }),
  );
  it.effect.each([
    { name: "OSC", sequence: "\u001b]0;unfinished" },
    { name: "DCS", sequence: "\u001bPunfinished" },
    { name: "PM", sequence: "\u001b^unfinished" },
    { name: "APC", sequence: "\u001b_unfinished" },
    { name: "CSI", sequence: "\u001b[5" },
  ])("keeps output after a cancelled $name sequence in history", ({ sequence }) =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(10);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      // A new escape sequence also aborts one, as in xterm.js; keep it last so CAN cannot end it.
      for (const cancel of ["\u0018", "\u001a", "\u001b[0m"]) {
        process.emitData(sequence);
        process.emitData(cancel);
        process.emitData("next line\n");
        process.emitData(`${sequence}${cancel}next line\n`);
      }
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      expect(reopened.history.match(/next line/g)).toHaveLength(6);
    }),
  );
  it.effect("handles CSI and DCS query sequences split across output chunks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b[?2026$");
      process.emitData("pafter ");
      process.emitData("\u001bP$q ");
      process.emitData("m\u001b");
      process.emitData("\\after ");
      process.emitData("\u001b[?3");
      process.emitData("1uafter ");
      process.emitData("\u001bP+q544e");
      process.emitData("\u001b\\after\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before after after after after\n");
    }),
  );
  it.effect("preserves large chunked OSC 52 and DCS strings across reopen", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const outputSeen = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output" && event.data === "done\n"
          ? Deferred.succeed(outputSeen, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const sequences = [
        { prefix: `\u001b]52;c;${"YWJj".repeat(16_384)}\u001b`, terminator: "\\" },
        { prefix: `\u001bPq${"?".repeat(65_536)}`, terminator: "\u001b\\" },
      ];
      const stripped = "\u001b]11;?\u0007\u001bP$q m\u001b\\";
      const preserved = "\u001b[31m\u001b]52;c;YWJj\u0007";
      const expected =
        sequences.map(({ prefix, terminator }) => prefix + terminator + preserved).join("") +
        "done\n";

      // Counts reads of strings larger than one emitted chunk, so rescanning the
      // pending prefix on every chunk shows up as quadratic work.
      const charCodeAt = String.prototype.charCodeAt;
      let largeStringReads = 0;
      yield* Effect.gen(function* () {
        // eslint-disable-next-line no-extend-native -- Count reads without retaining millions of spy call records.
        String.prototype.charCodeAt = function (this: string, index: number) {
          if (this.length > 4_096) largeStringReads += 1;
          return charCodeAt.call(this, index);
        };
        for (const { prefix, terminator } of sequences) {
          for (let offset = 0; offset < prefix.length; offset += 4_096) {
            process.emitData(prefix.slice(offset, offset + 4_096));
          }
          process.emitData(terminator + stripped + preserved);
        }
        process.emitData("done\n");
        yield* Deferred.await(outputSeen);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            // eslint-disable-next-line no-extend-native -- Restore the counting hook even when the test fails.
            String.prototype.charCodeAt = charCodeAt;
          }),
        ),
      );
      yield* manager.close({ threadId: "thread-1" });

      expect(largeStringReads).toBeLessThan(2 * expected.length);
      expect(yield* readFileString(yield* historyLogPath(logsDir))).toBe(expected);
      expect((yield* manager.open(openInput())).history.startsWith(expected)).toBe(true);
    }),
  );
  it.effect(
    "preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before ");
        process.emitData("\u001b(");
        process.emitData("Bafter\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        expect(reopened.history.startsWith("before \u001b(Bafter\n")).toBe(true);
      }),
  );
  it.effect.each([
    {
      label: "subagent",
      threadId:
        "thread:provider:claudeAgent:native-thread:provider-thread%3Aprovider%3AclaudeAgent%3Anative-thread%3Apending%253Arun%253Athread%253A9175fb53-52d7-4d4d-9be7-25a76cf84b91%253Aordinal%253A7%3Aad899ae84c7a131b0",
    },
    // Also too long for the legacy `<sanitized id>.log` lookup.
    { label: "300-character", threadId: "x".repeat(300) },
  ])("persists history for a $label thread id too long to encode into a filename", ({ threadId }) =>
    Effect.gen(function* () {
      const terminalId = "t".repeat(128);
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      const fs = yield* FileSystem.FileSystem;
      yield* manager.open(openInput({ threadId }));
      yield* manager.open(openInput({ threadId, terminalId }));
      ptyAdapter.processes[0]!.emitData("default\n");
      ptyAdapter.processes[1]!.emitData("long\n");
      yield* manager.close({ threadId });

      expect((yield* manager.open(openInput({ threadId }))).history).toBe("default\n");
      expect((yield* manager.open(openInput({ threadId, terminalId }))).history).toBe("long\n");

      yield* manager.close({ threadId, deleteHistory: true });
      expect(yield* fs.readDirectory(logsDir)).toEqual([]);
    }),
  );
  it.effect("keeps reading and deleting history at an encoded path that already fit", () =>
    Effect.gen(function* () {
      const threadId = "x".repeat(48);
      const { manager, logsDir } = yield* createManager();
      const fs = yield* FileSystem.FileSystem;
      const logPath = yield* historyLogPath(logsDir, threadId);
      yield* fs.makeDirectory(logsDir, { recursive: true });
      yield* fs.writeFileString(logPath, "before upgrade\n");

      expect((yield* manager.open(openInput({ threadId }))).history).toBe("before upgrade\n");
      // A long terminal id pushes only this terminal's name past the limit, so the thread's
      // history is split across both forms and deleting the thread must remove both.
      yield* manager.open(openInput({ threadId, terminalId: "t".repeat(128) }));

      yield* manager.close({ threadId, deleteHistory: true });
      expect(yield* fs.exists(logPath)).toBe(false);
      expect(yield* fs.readDirectory(logsDir)).toEqual([]);
    }),
  );
  it.effect.each([
    {
      label: "delegated setup",
      threadId:
        "thread:delegated-task:command%3Amcp%3A00000000-0000-4000-8000-000000000000%3Adelegate-task%3Aexample-r4-workspace-prepare-engine3",
      terminalId: "setup-setup-worktree-2",
    },
    { label: "long thread", threadId: "t".repeat(400), terminalId: DEFAULT_TERMINAL_ID },
    { label: "Unicode thread", threadId: "项目😀".repeat(60), terminalId: "setup" },
    { label: "long terminal", threadId: "short", terminalId: "t".repeat(128) },
    { label: "142-byte boundary", threadId: "t".repeat(48), terminalId: "s".repeat(48) },
    { label: "144-byte boundary", threadId: "t".repeat(49), terminalId: "s".repeat(48) },
  ])("persists $label history with a 143-byte filename limit", ({ threadId, terminalId }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const check = (filePath: string) =>
        Buffer.byteLength(path.basename(filePath)) <= 143
          ? Effect.void
          : Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "access",
                pathOrDescriptor: filePath,
                cause: { code: "ENAMETOOLONG" },
              }),
            );
      const limited = FileSystem.FileSystem.of({
        ...fs,
        exists: (filePath) => Effect.andThen(check(filePath), fs.exists(filePath)),
        open: (filePath, options) => Effect.andThen(check(filePath), fs.open(filePath, options)),
        writeFileString: (filePath, data, options) =>
          Effect.andThen(check(filePath), fs.writeFileString(filePath, data, options)),
        remove: (filePath, options) =>
          Effect.andThen(check(filePath), fs.remove(filePath, options)),
      });
      const { manager, ptyAdapter, logsDir } = yield* createManager().pipe(
        Effect.provideService(FileSystem.FileSystem, limited),
      );
      yield* manager.open(openInput({ threadId, terminalId }));
      ptyAdapter.processes[0]!.emitData("setup output\n");
      yield* manager.close({ threadId, terminalId });
      const names = yield* fs.readDirectory(logsDir);
      expect(names).toHaveLength(1);
      expect(Buffer.byteLength(names[0]!)).toBeLessThanOrEqual(143);
      expect((yield* manager.open(openInput({ threadId, terminalId }))).history).toBe(
        "setup output\n",
      );
      const otherThread = `${threadId}-other`;
      expect((yield* manager.open(openInput({ threadId: otherThread, terminalId }))).history).toBe(
        "",
      );
      ptyAdapter.processes[2]!.emitData("other output\n");
      yield* manager.close({ threadId: otherThread, terminalId });
      expect(yield* fs.readDirectory(logsDir)).toHaveLength(2);
      yield* manager.close({ threadId, terminalId, deleteHistory: true });
      expect(yield* fs.readDirectory(logsDir)).toHaveLength(1);
      yield* manager.close({ threadId: otherThread, deleteHistory: true });
      expect(yield* fs.readDirectory(logsDir)).toEqual([]);
    }),
  );
  it.effect.each([
    { source: "encoded", terminalId: DEFAULT_TERMINAL_ID },
    { source: "encoded", terminalId: "setup-setup-worktree-2" },
    { source: "sanitized", terminalId: DEFAULT_TERMINAL_ID },
  ])("migrates oversized $source history for $terminalId", ({ source, terminalId }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { manager, logsDir } = yield* createManager();
      const threadId = "m".repeat(100);
      const oldPath =
        source === "encoded"
          ? path.join(
              logsDir,
              `terminal_${Base64Url.encode(threadId)}${terminalId === DEFAULT_TERMINAL_ID ? "" : `_${Base64Url.encode(terminalId)}`}.log`,
            )
          : path.join(logsDir, `${threadId}.log`);
      yield* fs.writeFileString(oldPath, "old output\n");
      expect((yield* manager.open(openInput({ threadId, terminalId }))).history).toBe(
        "old output\n",
      );
      const names = yield* fs.readDirectory(logsDir);
      expect(names).toHaveLength(1);
      expect(Buffer.byteLength(names[0]!)).toBeLessThanOrEqual(143);
      expect(yield* fs.exists(oldPath)).toBe(false);
      expect(yield* fs.readFileString(path.join(logsDir, names[0]!))).toBe("old output\n");
      yield* manager.close({ threadId, terminalId, deleteHistory: true });
      expect(yield* fs.readDirectory(logsDir)).toEqual([]);
    }),
  );
  it.effect.each(["terminal", "thread"] as const)(
    "deletes compact and older encoded history when closing a %s",
    (scope) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { manager, logsDir } = yield* createManager();
        const threadId = "d".repeat(100);
        const terminalId = "setup-setup-worktree-2";
        yield* manager.open(openInput({ threadId, terminalId }));
        yield* manager.close({ threadId, terminalId });
        const oldPath = path.join(
          logsDir,
          `terminal_${Base64Url.encode(threadId)}_${Base64Url.encode(terminalId)}.log`,
        );
        yield* fs.writeFileString(oldPath, "stale copy\n");
        yield* fs.writeFileString(path.join(logsDir, "unrelated.log"), "keep\n");
        if (scope === "terminal") {
          yield* manager.close({ threadId, terminalId, deleteHistory: true });
        } else {
          yield* manager.close({ threadId, deleteHistory: true });
        }
        expect(yield* fs.readDirectory(logsDir)).toEqual(["unrelated.log"]);
      }),
  );
  it.effect("prefers bounded history over a stale encoded copy", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      const fs = yield* FileSystem.FileSystem;
      const threadId = "p".repeat(100);
      yield* manager.open(openInput({ threadId }));
      ptyAdapter.processes[0]!.emitData("current\n");
      yield* manager.close({ threadId });
      const oldPath = yield* historyLogPath(logsDir, threadId);
      yield* fs.writeFileString(oldPath, "stale\n");

      expect((yield* manager.open(openInput({ threadId }))).history).toBe("current\n");
      yield* manager.close({ threadId, terminalId: DEFAULT_TERMINAL_ID, deleteHistory: true });
      expect(yield* fs.readDirectory(logsDir)).toEqual([]);
    }),
  );
  it.effect("retains encoded history if migration cannot write the bounded file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let failNextWrite = true;
      const limited = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (filePath, data, options) => {
          if (!failNextWrite) return fs.writeFileString(filePath, data, options);
          failNextWrite = false;
          return fs.writeFileString(filePath, "partial").pipe(
            Effect.andThen(
              Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "writeFileString",
                  cause: { code: "ENOSPC" },
                }),
              ),
            ),
          );
        },
      });
      const { manager, logsDir } = yield* createManager().pipe(
        Effect.provideService(FileSystem.FileSystem, limited),
      );
      const threadId = "f".repeat(100);
      const oldPath = yield* historyLogPath(logsDir, threadId);
      yield* fs.writeFileString(oldPath, "preserve me\n");

      expect(Exit.isFailure(yield* Effect.exit(manager.open(openInput({ threadId }))))).toBe(true);
      expect(yield* fs.readFileString(oldPath)).toBe("preserve me\n");
      expect(yield* fs.readDirectory(logsDir)).toHaveLength(1);
      expect((yield* manager.open(openInput({ threadId }))).history).toBe("preserve me\n");
    }),
  );
  it.effect("migrates legacy transcript filenames to terminal-scoped history path on open", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      const path = yield* Path.Path;
      const legacyPath = path.join(logsDir, "thread-1.log");
      const nextPath = yield* historyLogPath(logsDir);
      yield* writeFileString(legacyPath, "legacy-line\n");

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.history, "legacy-line\n");
      expect(yield* pathExists(nextPath)).toBe(true);
      expect(yield* readFileString(nextPath)).toBe("legacy-line\n");
      expect(yield* pathExists(legacyPath)).toBe(false);
    }),
  );


  // Which client owns the shared PTY size is left open by the issue, so this only asserts
  // that every attached renderer is told the grid the PTY actually has.


  // Client retries resend the first attach's size, which a later resize may have replaced.





  const pathExists = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.exists(filePath));

  const readFileString = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.readFileString(filePath));

  const writeFileString = (filePath: string, contents: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.writeFileString(filePath, contents),
    );





  // Answers process-table queries after `queryDuration`, honoring the caller's
  // timeout the way ProcessRunner's `timedOutResult` mode does.
  const slowProcessTable = (
    platform: "linux" | "win32",
    queryDuration: Duration.Input,
    queries: Array<{ start: number; end?: number }>,
    started: ReadonlyArray<Deferred.Deferred<void>>,
  ): ProcessRunner.ProcessRunner["Service"] => ({
    run: (input) =>
      Effect.gen(function* () {
        const query: { start: number; end?: number } = { start: yield* Clock.currentTimeMillis };
        queries.push(query);
        const deferred = started[queries.length - 1];
        if (deferred) yield* Deferred.succeed(deferred, undefined);
        const completed = yield* Effect.sleep(queryDuration).pipe(
          Effect.timeoutOption(input.timeout ?? "1 hour"),
        );
        query.end = yield* Clock.currentTimeMillis;
        return {
          stdout: Option.isNone(completed)
            ? ""
            : platform === "win32"
              ? "100|9000|node.exe\n"
              : "  100  9000 node\n",
          stderr: "",
          code: Option.isSome(completed) ? ChildProcessSpawner.ExitCode(0) : null,
          timedOut: Option.isNone(completed),
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

  const createFallbackManager = (
    platform: "linux" | "win32",
    runner: ProcessRunner.ProcessRunner["Service"],
  ) =>
    createManager(5, { subprocessPollIntervalMs: 1_000, processKillGraceMs: 0 }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provide(layerWithHostPlatform(platform)),
    );










































});
