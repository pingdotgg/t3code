import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  makeKimiAcpTerminalManager,
  type KimiAcpTerminalManager,
} from "./KimiAcpTerminalSupport.ts";

const SESSION_ID = "kimi-terminal-test-session";

const withTerminalManager = <A, E>(
  body: (manager: KimiAcpTerminalManager) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const manager = yield* makeKimiAcpTerminalManager({ childProcessSpawner });
    return yield* body(manager).pipe(Effect.ensuring(manager.shutdown));
  }).pipe(Effect.provide(NodeServices.layer));

const nodeScript = (script: string): { command: string; args: ReadonlyArray<string> } => ({
  command: process.execPath,
  args: ["-e", script],
});

describe("KimiAcpTerminalSupport", () => {
  it.effect("runs a command through the full create/wait/output/release lifecycle", () =>
    withTerminalManager((manager) =>
      Effect.gen(function* () {
        const { command, args } = nodeScript(
          "process.stdout.write('hello-stdout');process.stderr.write('hello-stderr');process.exit(3)",
        );
        const created = yield* manager.handleCreateTerminal({
          sessionId: SESSION_ID,
          command,
          args,
        });
        assert.isString(created.terminalId);

        const exit = yield* manager.handleTerminalWaitForExit({
          sessionId: SESSION_ID,
          terminalId: created.terminalId,
        });
        // Top-level shape: exitCode/signal directly on the response, never
        // nested under exitStatus (Kimi reads a nested shape as exit -1).
        assert.strictEqual(exit.exitCode, 3);
        assert.isUndefined(exit.signal);
        assert.notProperty(exit, "exitStatus");

        const output = yield* manager.handleTerminalOutput({
          sessionId: SESSION_ID,
          terminalId: created.terminalId,
        });
        assert.include(output.output, "hello-stdout");
        assert.include(output.output, "hello-stderr");
        assert.isFalse(output.truncated);
        assert.strictEqual(output.exitStatus?.exitCode, 3);

        yield* manager.handleTerminalRelease({
          sessionId: SESSION_ID,
          terminalId: created.terminalId,
        });
        const releasedOutput = yield* Effect.flip(
          manager.handleTerminalOutput({
            sessionId: SESSION_ID,
            terminalId: created.terminalId,
          }),
        );
        assert.strictEqual(releasedOutput._tag, "AcpRequestError");
      }),
    ),
  );

  it.effect("applies request env vars and cwd to the spawned process", () =>
    withTerminalManager((manager) =>
      Effect.gen(function* () {
        const { command, args } = nodeScript(
          "process.stdout.write(process.env.KIMI_TERMINAL_TEST + '|' + process.cwd())",
        );
        const created = yield* manager.handleCreateTerminal({
          sessionId: SESSION_ID,
          command,
          args,
          cwd: process.cwd(),
          env: [{ name: "KIMI_TERMINAL_TEST", value: "env-visible" }],
        });
        yield* manager.handleTerminalWaitForExit({
          sessionId: SESSION_ID,
          terminalId: created.terminalId,
        });
        const output = yield* manager.handleTerminalOutput({
          sessionId: SESSION_ID,
          terminalId: created.terminalId,
        });
        assert.include(output.output, "env-visible|");
        assert.include(output.output, process.cwd());
      }),
    ),
  );

  it.effect("truncates output from the beginning when outputByteLimit is exceeded", () =>
    withTerminalManager((manager) =>
      Effect.gen(function* () {
        const { command, args } = nodeScript("process.stdout.write('0123456789ABCDEF')");
        const created = yield* manager.handleCreateTerminal({
          sessionId: SESSION_ID,
          command,
          args,
          outputByteLimit: 8,
        });
        yield* manager.handleTerminalWaitForExit({
          sessionId: SESSION_ID,
          terminalId: created.terminalId,
        });
        const output = yield* manager.handleTerminalOutput({
          sessionId: SESSION_ID,
          terminalId: created.terminalId,
        });
        assert.isTrue(output.truncated);
        assert.strictEqual(output.output, "89ABCDEF");
      }),
    ),
  );

  it.effect("kill terminates a long-running command and is idempotent", () =>
    withTerminalManager((manager) =>
      Effect.gen(function* () {
        const { command, args } = nodeScript("setTimeout(() => {}, 600000)");
        const created = yield* manager.handleCreateTerminal({
          sessionId: SESSION_ID,
          command,
          args,
        });
        yield* manager.handleTerminalKill({
          sessionId: SESSION_ID,
          terminalId: created.terminalId,
        });
        const exit = yield* manager.handleTerminalWaitForExit({
          sessionId: SESSION_ID,
          terminalId: created.terminalId,
        });
        // Killed processes report a signal (POSIX) or a non-zero exit code
        // (Windows); either way the command must not report success.
        assert.isTrue(exit.signal !== undefined || (exit.exitCode ?? 0) !== 0);
        // Second kill after exit is a no-op success.
        yield* manager.handleTerminalKill({
          sessionId: SESSION_ID,
          terminalId: created.terminalId,
        });
      }),
    ),
  );

  it.effect("shutdown kills open terminals and forgets them", () =>
    withTerminalManager((manager) =>
      Effect.gen(function* () {
        const { command, args } = nodeScript("setTimeout(() => {}, 600000)");
        const created = yield* manager.handleCreateTerminal({
          sessionId: SESSION_ID,
          command,
          args,
        });
        // Shutdown closes each terminal scope; the spawner finalizer kills
        // the process and waits for it to exit before returning.
        yield* manager.shutdown;
        const error = yield* Effect.flip(
          manager.handleTerminalWaitForExit({
            sessionId: SESSION_ID,
            terminalId: created.terminalId,
          }),
        );
        assert.strictEqual(error._tag, "AcpRequestError");
      }),
    ),
  );

  it.effect("reports unknown terminal ids as AcpRequestError", () =>
    withTerminalManager((manager) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          manager.handleTerminalOutput({
            sessionId: SESSION_ID,
            terminalId: "term-does-not-exist",
          }),
        );
        assert.strictEqual(error._tag, "AcpRequestError");
        assert.include(
          error._tag === "AcpRequestError" ? error.errorMessage : "",
          "term-does-not-exist",
        );
      }),
    ),
  );
});
