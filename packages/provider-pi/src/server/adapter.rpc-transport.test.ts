import {
  ChildProcessSpawner,
  Deferred,
  Effect,
  FAKE_PID,
  FileSystem,
  HostProcess,
  Layer,
  Logger,
  NodeServices,
  Queue,
  Sink,
  Stream,
  assert,
  describe,
  it,
  makePiRpcConnection,
} from "./adapter-fixtures.testkit.ts";

describe("PiRpc framing", () => {
  it.effect("reassembles records and warns when dropping oversized records", () => {
    const warnings: Array<ReadonlyArray<unknown>> = [];
    const warned = Deferred.makeUnsafe<void>();
    const logCapture = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Warn" && Array.isArray(message)) {
        warnings.push(message);
        Deferred.doneUnsafe(warned, Effect.void);
      }
    });
    return Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const push = (text: string) =>
        Queue.offer(stdout, new TextEncoder().encode(text)).pipe(Effect.asVoid);
      yield* push('{"type":"agent_');
      yield* push('start"}\r\n{"type":"agent_settled"}\nnot json\n{"type":"queue_update"}\n');

      const head = '{"type":"must_not_emit","text":"';
      yield* push(head);
      const chunk = new TextEncoder().encode("x".repeat(8 * 1024 * 1024));
      for (let index = 0; index < 32; index++) yield* Queue.offer(stdout, chunk);
      yield* Deferred.await(warned);
      yield* push('"}\n{"type":"after_oversized"}\n');

      const first = yield* Queue.take(connection.events);
      assert.equal(first["type"], "agent_start");
      const second = yield* Queue.take(connection.events);
      assert.equal(second["type"], "agent_settled");
      const third = yield* Queue.take(connection.events);
      assert.equal(third["type"], "queue_update");
      assert.equal((yield* Queue.take(connection.events))["type"], "after_oversized");
      assert.lengthOf(warnings, 1);
      const [text, annotations] = warnings[0] ?? [];
      assert.equal(text, "Dropping oversized pi stdout record.");
      assert.deepEqual(annotations, {
        recordLength: head.length + 28 * chunk.length,
        maxRecordLength: 232084864,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logCapture], { mergeWithExisting: false })),
      ),
    );
  });
});

describe("PiRpc early process exit", () => {
  const makeHandle = (options: {
    readonly exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>;
    readonly stderr: Stream.Stream<Uint8Array>;
  }) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(FAKE_PID),
      exitCode: options.exitCode,
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: options.stderr,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });

  it.effect("reports a nonzero exit code instead of an unexplained stdout close", () =>
    Effect.gen(function* () {
      const secret = "API_KEY=super-secret\n";
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          makeHandle({
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            stderr: Stream.fromIterable([new TextEncoder().encode(secret)]),
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const error = yield* Queue.take(connection.events).pipe(Effect.flip);
      assert.equal(error._tag, "PiRpcError");
      assert.equal(error.operation, "read");
      assert.equal(error.detail, "pi process exited with code 1");
      assert.isFalse((error.detail ?? "").includes("API_KEY"));
      assert.isFalse((error.detail ?? "").includes("super-secret"));
      assert.isFalse(error.message.includes("API_KEY"));
      assert.isFalse(error.message.includes("super-secret"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("PiRpc teardown", () => {
  // Like pi, quits once stdin ends; it survives SIGTERM, so teardown's SIGKILL ends it otherwise.
  const recordShutdownCues = `
const fs = require("node:fs");
const note = (cue) => fs.appendFileSync(process.argv[1], cue + "\\n");
process.on("SIGTERM", () => note("SIGTERM"));
process.stdin.on("end", () => note("stdin end")).resume();
process.stdout.write('{"type":"ready"}\\n');
`;

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "signals pi before its stdin reaches EOF",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cuesPath = `${yield* fileSystem.makeTempDirectoryScoped()}/cues`;
        yield* Effect.gen(function* () {
          const connection = yield* makePiRpcConnection({
            command: process.execPath,
            args: ["-e", recordShutdownCues, cuesPath],
            cwd: undefined,
            env: {},
          });
          assert.equal((yield* Queue.take(connection.events))["type"], "ready");
        }).pipe(Effect.scoped);

        const cues = (yield* fileSystem.readFileString(cuesPath)).split("\n").filter(Boolean);
        assert.deepEqual(cues, ["SIGTERM"]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
