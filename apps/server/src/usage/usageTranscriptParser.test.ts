// @effect-diagnostics nodeBuiltinImport:off -- Real workers report job receipt over loopback sockets.
import * as NodeNet from "node:net";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";

import { BUILT_IN_USAGE_DRIVERS } from "../provider/builtInDrivers.ts";
import { TRANSCRIPT_FORMAT_MAP, TRANSCRIPT_FORMATS } from "./usageTranscriptFormats.ts";
import { makeTranscriptParser, TranscriptParserCapacity } from "./usageTranscriptParser.ts";
import { readTranscriptRecords } from "./usageTranscriptReader.ts";

// Above the in-process threshold, so these files go to a worker.
const LARGE_BYTES = 512 * 1024;

const makeWorkerParser = makeTranscriptParser.pipe(
  Effect.provideService(TranscriptParserCapacity, { cores: 3, availableMemory: 4 * 1024 ** 3 }),
);

function codexLines(from: number, count: number): string {
  const lines = [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-08-01T10:00:00Z",
      payload: { type: "session_meta", id: "codex-session-1" },
    }),
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-08-01T10:00:01Z",
      payload: { type: "turn_context", model: "gpt-5.5" },
    }),
  ];
  for (let index = from; index < from + count; index += 1) {
    lines.push(
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-01T10:00:02Z",
        payload: { type: "message", content: "x".repeat(4096) },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: `2026-08-01T10:${String(index % 60).padStart(2, "0")}:02Z`,
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 100 + index, output_tokens: 7 } },
        },
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

function claudeLine(id: number, padding: number): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model: "claude-fable-5",
      content: "y".repeat(padding),
      usage: { input_tokens: 10, output_tokens: id },
    },
  })}\n`;
}

/** Runs `script` in each worker before the worker entry; it can append to `log`. */
const preload = (script: string) => ({
  ...process.env,
  NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(script)}`,
});

const recordPid = (log: string) =>
  `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, process.pid + "\\n");`;

const loggedPids = async (log: string) =>
  (await NodeFSP.readFile(log, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.length > 0)
    .map(Number);

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const withTempDir = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-parser-test-"))),
    use,
    (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
  );

const captureWarnings = (warnings: unknown[]) =>
  Logger.layer(
    [Logger.make(({ message, logLevel }) => (logLevel === "Warn" ? warnings.push(message) : 0))],
    { mergeWithExisting: false },
  );

describe("makeTranscriptParser", () => {
  it("gives workers every built-in driver's transcript format", () => {
    for (const driver of BUILT_IN_USAGE_DRIVERS) {
      if (driver.usage?.kind !== "transcripts") continue;
      assert.strictEqual(TRANSCRIPT_FORMAT_MAP.get(driver.usage.provider), driver.usage.format);
    }
  });

  it.live("parses large transcripts in workers with the in-process result", () => {
    const warnings: unknown[] = [];
    return withTempDir((dir) =>
      Effect.gen(function* () {
        const log = NodePath.join(dir, "pids");
        const codex = NodePath.join(dir, "codex.jsonl");
        const claude = NodePath.join(dir, "claude.jsonl");
        const small = NodePath.join(dir, "small.jsonl");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(codex, codexLines(0, 160));
          // An unterminated tail and one line longer than a read chunk.
          await NodeFSP.writeFile(
            claude,
            claudeLine(1, 300 * 1024) + claudeLine(2, 10) + claudeLine(3, 10).trimEnd(),
          );
          await NodeFSP.writeFile(small, claudeLine(4, 10));
        });
        const parser = yield* makeWorkerParser.pipe(
          Effect.provideService(HostProcess.Environment, preload(recordPid(log))),
        );
        const read = (path: string, format: "codex" | "claude") =>
          Effect.promise(() => NodeFSP.stat(path)).pipe(
            Effect.flatMap(({ size }) =>
              parser.read({
                path,
                size,
                provider: format,
                format: TRANSCRIPT_FORMATS[format],
                resumeFrom: undefined,
              }),
            ),
          );

        const [codexParsed, claudeParsed, smallParsed] = yield* Effect.all(
          [read(codex, "codex"), read(claude, "claude"), read(small, "claude")],
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(
          codexParsed,
          yield* Effect.promise(() => readTranscriptRecords(codex, TRANSCRIPT_FORMATS.codex)),
        );
        assert.deepStrictEqual(
          claudeParsed,
          yield* Effect.promise(() => readTranscriptRecords(claude, TRANSCRIPT_FORMATS.claude)),
        );
        assert.strictEqual(claudeParsed?.tailRecords.length, 1);
        assert.deepStrictEqual(
          smallParsed,
          yield* Effect.promise(() => readTranscriptRecords(small, TRANSCRIPT_FORMATS.claude)),
        );

        // A grown file resumes in a worker from the encoded reducer state.
        yield* Effect.promise(() => NodeFSP.appendFile(codex, codexLines(160, 100)));
        const { size } = yield* Effect.promise(() => NodeFSP.stat(codex));
        const resumed = yield* parser.read({
          path: codex,
          size,
          provider: "codex",
          format: TRANSCRIPT_FORMATS.codex,
          resumeFrom: codexParsed!.position,
        });
        assert.isTrue(resumed?.resumed);
        assert.deepStrictEqual(
          resumed,
          yield* Effect.promise(() =>
            readTranscriptRecords(codex, TRANSCRIPT_FORMATS.codex, codexParsed!.position),
          ),
        );
        // Only the two large files needed workers.
        const pids = yield* Effect.promise(() => loggedPids(log));
        assert.isAtLeast(pids.length, 1);
        assert.isAtMost(pids.length, 2);
        assert.deepStrictEqual(warnings, []);
      }),
    ).pipe(Effect.provide(captureWarnings(warnings)));
  });

  it.live.each([
    { cores: 2, availableMemory: 4 * 1024 ** 3 },
    { cores: 8, availableMemory: 1024 ** 3 },
  ])(
    "reads large transcripts inline with capacity $cores cores / $availableMemory bytes",
    (capacity) =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const path = NodePath.join(dir, "codex.jsonl");
          const log = NodePath.join(dir, "pids");
          yield* Effect.promise(() => NodeFSP.writeFile(path, codexLines(0, 140)));
          const { size } = yield* Effect.promise(() => NodeFSP.stat(path));
          const parser = yield* makeTranscriptParser.pipe(
            Effect.provideService(TranscriptParserCapacity, capacity),
            Effect.provideService(HostProcess.Environment, preload(recordPid(log))),
          );
          assert.deepStrictEqual(
            yield* parser.read({
              path,
              size,
              provider: "codex",
              format: TRANSCRIPT_FORMATS.codex,
              resumeFrom: undefined,
            }),
            yield* Effect.promise(() => readTranscriptRecords(path, TRANSCRIPT_FORMATS.codex)),
          );
          assert.deepStrictEqual(yield* Effect.promise(() => loggedPids(log)), []);
        }),
      ),
  );

  it.live.each([
    {
      name: "a worker that cannot start",
      environment: process.env,
      // The executable then treats the worker command as a script path and exits.
      isExecutable: true,
    },
    {
      name: "a worker that exits after ready",
      environment: preload(
        `process.send({ ready: true }, () => process.exit(9)); await new Promise(() => {});`,
      ),
      isExecutable: false,
    },
    {
      name: "a worker that exits mid-job",
      environment: preload(`process.on("message", () => process.exit(9));`),
      isExecutable: false,
    },
    {
      name: "a worker whose result send throws",
      environment: preload(`
        const send = process.send.bind(process);
        process.send = (message, ...rest) => {
          if ("result" in message) throw new Error("Cannot send result");
          return send(message, ...rest);
        };
        process.on("unhandledRejection", async () => {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(process.env.USAGE_TEST_UNHANDLED, "unhandled rejection");
          send({ ready: true });
        });
      `),
      isExecutable: false,
    },
  ])("reads in process after $name", ({ environment, isExecutable }) => {
    const warnings: unknown[] = [];
    return withTempDir((dir) =>
      Effect.gen(function* () {
        const paths = [NodePath.join(dir, "a.jsonl"), NodePath.join(dir, "b.jsonl")];
        for (const path of paths) {
          yield* Effect.promise(() => NodeFSP.writeFile(path, codexLines(0, 140)));
        }
        const unhandled = NodePath.join(dir, "unhandled");
        const parser = yield* makeWorkerParser.pipe(
          Effect.provideService(HostProcess.Environment, {
            ...environment,
            USAGE_TEST_UNHANDLED: unhandled,
          }),
          Effect.provideService(HostProcess.IsExecutable, isExecutable),
        );
        for (const path of paths) {
          const { size } = yield* Effect.promise(() => NodeFSP.stat(path));
          assert.isTrue(size > LARGE_BYTES);
          const parsed = yield* parser.read({
            path,
            size,
            provider: "codex",
            format: TRANSCRIPT_FORMATS.codex,
            resumeFrom: undefined,
          });
          assert.deepStrictEqual(
            parsed,
            yield* Effect.promise(() => readTranscriptRecords(path, TRANSCRIPT_FORMATS.codex)),
          );
        }
        // The pool emits only one warning across both reads.
        assert.strictEqual(warnings.length, 1);
        assert.isFalse(
          yield* Effect.promise(() =>
            NodeFSP.access(unhandled).then(
              () => true,
              () => false,
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(captureWarnings(warnings)));
  });

  it.live.each(["closing the scope", "interrupting its read"] as const)(
    "stops a worker on %s",
    (ending) =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const log = NodePath.join(dir, "pids");
          const path = NodePath.join(dir, "codex.jsonl");
          yield* Effect.promise(() => NodeFSP.writeFile(path, codexLines(0, 140)));
          const { size } = yield* Effect.promise(() => NodeFSP.stat(path));
          const receipt = yield* Effect.acquireRelease(
            Effect.promise(async () => {
              const received = Promise.withResolvers<string>();
              let connection: NodeNet.Socket | undefined;
              const server = NodeNet.createServer((socket) => {
                connection = socket;
                let pid = "";
                socket.setEncoding("utf8");
                socket.on("data", (chunk) => {
                  pid += chunk;
                });
                socket.once("end", () => received.resolve(pid));
                socket.on("error", received.reject);
              });
              await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
              });
              const address = server.address();
              assert.isNotNull(address);
              assert.isNotString(address);
              return {
                port: (address as NodeNet.AddressInfo).port,
                received: received.promise,
                close: () =>
                  new Promise<void>((resolve) => {
                    connection?.destroy();
                    server.close(() => resolve());
                  }),
              };
            }),
            (receipt) => Effect.promise(receipt.close),
          );
          // Workers acknowledge receipt but never reply, keeping the read in flight.
          const silent = `${recordPid(log)}
            import { connect } from "node:net";
            process.once("message", () => {
              const socket = connect(${receipt.port}, "127.0.0.1", () => socket.end(String(process.pid)));
            });
            const send = process.send.bind(process);
            process.send = (message, ...rest) => ("ready" in message ? send(message, ...rest) : true);`;
          const scope = yield* Scope.make();
          const parser = yield* makeWorkerParser.pipe(
            Effect.provideService(HostProcess.Environment, preload(silent)),
            Scope.provide(scope),
          );
          const read = parser.read({
            path,
            size,
            provider: "codex",
            format: TRANSCRIPT_FORMATS.codex,
            resumeFrom: undefined,
          });
          const reading = yield* read.pipe(Effect.forkChild);
          const receivedPid = yield* Effect.promise(() => receipt.received);
          assert.isAbove(Number(receivedPid), 0);
          if (ending === "closing the scope") {
            yield* Scope.close(scope, Exit.void);
            // A closed parser reads nothing more, in a worker or in process.
            assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(reading)));
            assert.isTrue(Exit.hasInterrupts(yield* Effect.exit(read)));
          } else {
            yield* Fiber.interrupt(reading);
            yield* Scope.close(scope, Exit.void);
          }
          const pids = yield* Effect.promise(() => loggedPids(log));
          assert.isNotEmpty(pids);
          assert.isTrue(pids.every((pid) => !isRunning(pid)));
        }),
      ),
  );
});
