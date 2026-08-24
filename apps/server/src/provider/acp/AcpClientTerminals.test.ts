import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  makeAcpClientTerminals,
  resolveEmbeddedTerminalContent,
  type AcpClientTerminals,
} from "./AcpClientTerminals.ts";

const withTerminals = <A, E>(use: (terminals: AcpClientTerminals) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const terminals = yield* makeAcpClientTerminals({
      spawner,
      defaultCwd: process.cwd(),
    });
    return yield* use(terminals).pipe(Effect.ensuring(terminals.disposeAll));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("AcpClientTerminals", () => {
  it.effect("runs a command, buffers output, and reports the exit status", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const created = yield* terminals.create({
          sessionId: "session",
          command: process.execPath,
          args: ["-e", "console.log('hello from acp'); process.exit(3);"],
        });

        const exit = yield* terminals.waitForExit({
          sessionId: "session",
          terminalId: created.terminalId,
        });
        expect(exit.exitCode).toBe(3);

        const output = yield* terminals.output({
          sessionId: "session",
          terminalId: created.terminalId,
        });
        expect(output.output).toContain("hello from acp");
        expect(output.truncated).toBe(false);
        expect(output.exitStatus?.exitCode).toBe(3);
      }),
    ),
  );

  it.effect("resolves terminal environment from the requesting ACP session", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const terminals = yield* makeAcpClientTerminals({
        spawner,
        defaultCwd: process.cwd(),
        environmentForSession: (sessionId) => ({
          T3_TEST_ACP_SESSION_TOKEN: sessionId === "session-a" ? "token-a" : "token-b",
        }),
      });
      yield* Effect.addFinalizer(() => terminals.disposeAll);

      for (const [sessionId, expected] of [
        ["session-a", "token-a"],
        ["session-b", "token-b"],
      ] as const) {
        const created = yield* terminals.create({
          sessionId,
          command: process.execPath,
          args: ["-e", "process.stdout.write(process.env.T3_TEST_ACP_SESSION_TOKEN ?? '')"],
        });
        yield* terminals.waitForExit({ sessionId, terminalId: created.terminalId });
        const output = yield* terminals.output({ sessionId, terminalId: created.terminalId });
        expect(output.output).toBe(expected);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("truncates buffered output from the beginning at the byte limit", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const created = yield* terminals.create({
          sessionId: "session",
          command: process.execPath,
          args: ["-e", "process.stdout.write('a'.repeat(64) + 'TAIL');"],
          outputByteLimit: 16,
        });
        yield* terminals.waitForExit({ sessionId: "session", terminalId: created.terminalId });

        const output = yield* terminals.output({
          sessionId: "session",
          terminalId: created.terminalId,
        });
        expect(output.truncated).toBe(true);
        expect(output.output.endsWith("TAIL")).toBe(true);
        expect(output.output.length).toBeLessThanOrEqual(16);
      }),
    ),
  );

  it.effect("kills long-running commands and rejects released terminal handles", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const created = yield* terminals.create({
          sessionId: "session",
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000);"],
        });
        yield* terminals.kill({ sessionId: "session", terminalId: created.terminalId });
        const exit = yield* terminals.waitForExit({
          sessionId: "session",
          terminalId: created.terminalId,
        });
        expect(exit.exitCode === 0 ? null : exit.exitCode).not.toBe(0);
        expect(exit.signal).toBe("SIGTERM");

        yield* terminals.release({ sessionId: "session", terminalId: created.terminalId });
        const rejected = yield* Effect.flip(
          terminals.output({ sessionId: "session", terminalId: created.terminalId }),
        );
        expect(rejected.message).toContain("unknown terminal ID");

        // Embedded tool-call content still renders released terminals.
        expect(terminals.readOutputSnapshot("session", created.terminalId)).toBeDefined();
      }),
    ),
  );

  it.effect("reserves terminal capacity across concurrent creates", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          Array.from({ length: 17 }, () =>
            terminals
              .create({
                sessionId: "session",
                command: process.execPath,
                args: ["-e", "setInterval(() => {}, 1000);"],
              })
              .pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );

        expect(results.filter(Result.isSuccess)).toHaveLength(16);
        expect(results.filter(Result.isFailure)).toHaveLength(1);
      }),
    ),
  );

  it.effect("bounds retained snapshots after terminals are released", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const terminalIds: string[] = [];
        for (let index = 0; index < 33; index += 1) {
          const created = yield* terminals.create({
            sessionId: "session",
            command: process.execPath,
            args: ["-e", `process.stdout.write('${index}');`],
          });
          yield* terminals.release({ sessionId: "session", terminalId: created.terminalId });
          terminalIds.push(created.terminalId);
        }

        expect(terminals.readOutputSnapshot("session", terminalIds[0]!)).toBeUndefined();
        expect(terminals.readOutputSnapshot("session", terminalIds.at(-1)!)).toBeDefined();
      }),
    ),
  );

  it.effect("bounds unreleased terminal handles without invalidating existing ids", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const terminalIds: string[] = [];
        for (let index = 0; index < 64; index += 1) {
          const created = yield* terminals.create({
            sessionId: "session",
            command: process.execPath,
            args: ["-e", `process.stdout.write('${index}');`],
          });
          yield* terminals.waitForExit({
            sessionId: "session",
            terminalId: created.terminalId,
          });
          terminalIds.push(created.terminalId);
        }

        const rejected = yield* terminals
          .create({
            sessionId: "session",
            command: process.execPath,
            args: ["-e", ""],
          })
          .pipe(Effect.result);
        expect(Result.isFailure(rejected)).toBe(true);
        expect(terminals.readOutputSnapshot("session", terminalIds[0]!)).toBeDefined();
        expect(terminals.readOutputSnapshot("session", terminalIds.at(-1)!)).toBeDefined();
      }),
    ),
  );

  it.effect("bounds aggregate output retained across unreleased terminals", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const terminalIds: string[] = [];
        for (let index = 0; index < 3; index += 1) {
          const created = yield* terminals.create({
            sessionId: "session",
            command: process.execPath,
            args: ["-e", "process.stdout.write('x'.repeat(8 * 1024 * 1024));"],
            outputByteLimit: 8 * 1024 * 1024,
          });
          yield* terminals.waitForExit({
            sessionId: "session",
            terminalId: created.terminalId,
          });
          terminalIds.push(created.terminalId);
        }

        const snapshots = terminalIds.map(
          (terminalId) => terminals.readOutputSnapshot("session", terminalId)!,
        );
        const retainedBytes = snapshots.reduce(
          (total, snapshot) => total + Buffer.byteLength(snapshot.output),
          0,
        );
        expect(retainedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
        expect(snapshots.some((snapshot) => snapshot.truncated)).toBe(true);
      }),
    ),
  );

  it.effect("rejects terminal handles from a different ACP session", () =>
    withTerminals((terminals) =>
      Effect.gen(function* () {
        const created = yield* terminals.create({
          sessionId: "owner-session",
          command: process.execPath,
          args: ["-e", "process.stdout.write('owned');"],
        });
        const foreignRequest = {
          sessionId: "foreign-session",
          terminalId: created.terminalId,
        };
        const results = yield* Effect.all(
          [
            terminals.output(foreignRequest),
            terminals.waitForExit(foreignRequest),
            terminals.kill(foreignRequest),
            terminals.release(foreignRequest),
          ].map((effect) => effect.pipe(Effect.result)),
          { concurrency: "unbounded" },
        );

        expect(results.every(Result.isFailure)).toBe(true);
        expect(terminals.readOutputSnapshot("foreign-session", created.terminalId)).toBeUndefined();
        expect(terminals.readOutputSnapshot("owner-session", created.terminalId)).toBeDefined();
      }),
    ),
  );
});

describe("resolveEmbeddedTerminalContent", () => {
  it("rewrites terminal content into text from the buffered snapshot", () => {
    const notification = {
      sessionId: "session",
      update: {
        sessionUpdate: "tool_call_update" as const,
        toolCallId: "call-1",
        content: [
          { type: "content" as const, content: { type: "text" as const, text: "before" } },
          { type: "terminal" as const, terminalId: "t3-term-1" },
          { type: "terminal" as const, terminalId: "t3-term-unknown" },
        ],
      },
    };

    const resolved = resolveEmbeddedTerminalContent(notification, (sessionId, terminalId) =>
      sessionId === "session" && terminalId === "t3-term-1"
        ? { output: "compiled 3 files", truncated: false, exitStatus: undefined }
        : undefined,
    );

    expect(resolved.update).toMatchObject({
      content: [
        { type: "content", content: { type: "text", text: "before" } },
        { type: "content", content: { type: "text", text: "compiled 3 files" } },
        { type: "content", content: { type: "text", text: "[terminal t3-term-unknown]" } },
      ],
    });
  });
});
