import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { PiRpcError, type PiRpcConnection, type PiRpcRecord } from "./PiRpc.ts";
import { runPiSessionCommand } from "./PiSessionCommands.ts";

const threadId = ThreadId.make("pi-session-commands");
const html = "<!doctype html><html><body>Pi session</body></html>";

const makeHarness = Effect.fnUntraced(function* (text: string | null = "Last response") {
  const fs = yield* FileSystem.FileSystem;
  const requests: PiRpcRecord[] = [];
  let exportPath = "";
  let gistArgs: readonly string[] = [];
  let gistCode = 0;
  let gistStderr = "";
  const connection = {
    request: (record: PiRpcRecord) =>
      Effect.gen(function* () {
        requests.push(record);
        if (record.type === "get_last_assistant_text") return { text };
        assert.equal(record.type, "export_html");
        assert.isString(record.outputPath);
        exportPath = String(record.outputPath);
        yield* fs.writeFileString(exportPath, html).pipe(Effect.orDie);
        return { path: exportPath };
      }),
    send: () => Effect.die("Session utilities must never send a prompt"),
    events: yield* Queue.unbounded<PiRpcRecord, PiRpcError>(),
    exited: Effect.never,
    terminate: Effect.void,
  } satisfies PiRpcConnection;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (ChildProcess.isStandardCommand(command)) gistArgs = command.args;
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(gistCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.succeed(
          new TextEncoder().encode("https://gist.github.com/davis/abcdef123456\n"),
        ),
        stderr: Stream.succeed(new TextEncoder().encode(gistStderr)),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return {
    connection,
    spawner,
    requests,
    exportPath: () => exportPath,
    gistArgs: () => gistArgs,
    failGist: () => {
      gistCode = 1;
      gistStderr = "Run gh auth login";
    },
  };
});

describe("Pi session utilities", () => {
  it.effect("rejects arguments to copy before making an RPC request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* runPiSessionCommand(
        { threadId, command: "copy", outputPath: "extra" },
        harness.connection,
        {},
        undefined,
      ).pipe(Effect.flip);
      assert.include(error.message, "does not accept arguments");
      assert.deepEqual(harness.requests, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("reads the last assistant text without submitting a prompt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* runPiSessionCommand(
        { threadId, command: "copy" },
        harness.connection,
        {},
        undefined,
      );
      assert.deepEqual(result, { command: "copy", text: "Last response" });
      assert.deepEqual(harness.requests, [{ type: "get_last_assistant_text" }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails copy when the session has no assistant response", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(null);
      const error = yield* runPiSessionCommand(
        { threadId, command: "copy" },
        harness.connection,
        {},
        undefined,
      ).pipe(Effect.flip);
      assert.include(error.message, "No assistant response");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns downloadable HTML and removes the temporary export", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const harness = yield* makeHarness();
      const result = yield* runPiSessionCommand(
        { threadId, command: "export" },
        harness.connection,
        {},
        undefined,
      ).pipe(Effect.scoped);
      assert.deepEqual(result, { command: "export", fileName: "session.html", html });
      assert.isFalse(yield* fs.exists(harness.exportPath()));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves an explicit export path in the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const harness = yield* makeHarness();
      const result = yield* runPiSessionCommand(
        { threadId, command: "export", outputPath: "my session.html" },
        harness.connection,
        {},
        cwd,
      ).pipe(Effect.scoped);
      assert.equal(result.command, "export");
      assert.equal(yield* fs.readFileString(`${cwd}/my session.html`), html);
      assert.equal(harness.exportPath(), `${cwd}/my session.html`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("shares an unlisted gist and returns the Pi viewer URL", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const harness = yield* makeHarness();
      const result = yield* runPiSessionCommand(
        { threadId, command: "share" },
        harness.connection,
        {},
        undefined,
      ).pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, harness.spawner),
      );
      assert.deepEqual(result, { command: "share", url: "https://pi.dev/session/#abcdef123456" });
      assert.deepEqual(harness.gistArgs(), [
        "gist",
        "create",
        "--public=false",
        harness.exportPath(),
      ]);
      assert.isFalse(yield* fs.exists(harness.exportPath()));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a sharing failure and still removes the temporary export", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const harness = yield* makeHarness();
      harness.failGist();
      const error = yield* runPiSessionCommand(
        { threadId, command: "share" },
        harness.connection,
        {},
        undefined,
      ).pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, harness.spawner),
        Effect.flip,
      );
      assert.include(error.message, "gh auth login");
      assert.isFalse(yield* fs.exists(harness.exportPath()));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
