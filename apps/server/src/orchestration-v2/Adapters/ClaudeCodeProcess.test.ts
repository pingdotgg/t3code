// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProviderProcessLedger from "../../provider/ProviderProcessLedger.ts";
import { type ClaudeCodeProcess, makeClaudeCodeProcessFactory } from "./ClaudeCodeProcess.ts";

const groupExists = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Stands in for a T3 server: alive while its ledger is created, SIGKILLed later. */
const spawnServer = Effect.acquireRelease(
  Effect.sync(() =>
    NodeChildProcess.spawn("/bin/sh", ["-c", "sleep 600"], { detached: true, stdio: "ignore" }),
  ),
  (server) => Effect.sync(() => server.kill("SIGKILL")),
);

const waitForExit = (child: NodeChildProcess.ChildProcess) =>
  Effect.callback<NodeJS.Signals | null>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(child.signalCode));
      return;
    }
    child.once("exit", (_code, signal) => resume(Effect.succeed(signal)));
  });

/**
 * A Claude Code factory whose ledger belongs to `ownerPid` and reports when a
 * spawn has been recorded and when it has been forgotten.
 */
const makeFactory = (stateDir: string, ownerPid: number) =>
  Effect.gen(function* () {
    const ledger = yield* ProviderProcessLedger.make({ stateDir, ownerPid });
    const recorded = yield* Deferred.make<void>();
    const forgotten = yield* Deferred.make<void>();
    const factory = yield* makeClaudeCodeProcessFactory.pipe(
      Effect.provideService(
        ProviderProcessLedger.ProviderProcessLedger,
        ProviderProcessLedger.ProviderProcessLedger.of({
          track: (spawned) =>
            ledger.track(spawned).pipe(
              Effect.tap(() => Deferred.succeed(recorded, undefined)),
              Effect.map((forget) =>
                Effect.andThen(forget, Deferred.succeed(forgotten, undefined)),
              ),
            ),
        }),
      ),
    );
    if (factory === undefined) return yield* Effect.die("no Claude Code spawner on this platform");
    return {
      factory,
      recorded: Deferred.await(recorded),
      forgotten: Deferred.await(forgotten),
    };
  });

const spawnCli = (claudeCode: ClaudeCodeProcess, script: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      claudeCode.spawn({
        command: "/bin/sh",
        args: ["-c", script, "claude", "--output-format", "stream-json"],
        env: process.env,
        signal: new AbortController().signal,
      }),
    ),
    (cli) =>
      Effect.sync(() => {
        if (cli.pid !== undefined && groupExists(cli.pid)) process.kill(-cli.pid, "SIGKILL");
      }),
  );

/** Resolves on the exit the SDK sees, which waits for stderr to drain. */
const waitForSdkExit = (cli: SpawnedProcess) =>
  Effect.callback<NodeJS.Signals | null>((resume) => {
    if (cli.exitCode !== null || cli.signalCode != null) {
      resume(Effect.succeed(cli.signalCode ?? null));
      return;
    }
    cli.once("exit", (_code, signal) => resume(Effect.succeed(signal)));
  });

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("Claude Code process", () => {
  it.live("stops a CLI that outlived a killed server on the next server start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-process-" });
      const server = yield* spawnServer;
      const { factory, recorded } = yield* makeFactory(stateDir, server.pid!);

      // Like the real CLI mid-turn: it keeps working after stdin closes, and
      // the whole group has to go, not just the leader.
      const cli = yield* spawnCli(factory(), "trap '' HUP; sleep 600 & wait");
      yield* recorded;
      expect(groupExists(cli.pid!)).toBe(true);

      // The server dies without running any finalizer.
      server.kill("SIGKILL");
      yield* waitForExit(server);
      cli.stdin?.destroy();
      cli.stdout?.destroy();

      const restarted = yield* ProviderProcessLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(yield* waitForSdkExit(cli)).toBe("SIGTERM");
      expect(groupExists(cli.pid!)).toBe(false);
      expect(yield* fs.readDirectory(path.join(stateDir, "provider-processes"))).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("forgets a CLI that exits and keeps its stderr for the exit error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-process-" });
      const { factory, recorded, forgotten } = yield* makeFactory(stateDir, process.pid);
      const claudeCode = factory();

      const cli = yield* spawnCli(
        claudeCode,
        "read line; echo 'unknown option --x token=sk-ant-0123456789abcdefghij' >&2; exit 3",
      );
      yield* recorded;
      expect(yield* fs.readDirectory(path.join(stateDir, "provider-processes"))).toHaveLength(1);
      const sdkSawExit = new Promise<void>((resolve) => cli.once("exit", () => resolve()));
      cli.stdin.end("go\n");
      // The SDK builds its exit error as soon as it sees the exit.
      yield* Effect.promise(() => sdkSawExit);
      const error = claudeCode.withStderr(new Error("Claude Code process exited with code 3"));
      yield* forgotten;

      expect(yield* fs.readDirectory(path.join(stateDir, "provider-processes"))).toEqual([]);
      expect((error as Error).message).toBe(
        "Claude Code process exited with code 3. stderr: unknown option --x token=[REDACTED]",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("stops what the CLI left in its process group when it exits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-process-" });
      const { factory, recorded, forgotten } = yield* makeFactory(stateDir, process.pid);

      // The background sleep inherits the CLI's stdout, so the pipe closes only
      // once that leftover group member is dead too.
      const cli = yield* spawnCli(factory(), "read line; sleep 600 & exit 0");
      const stdoutClosed = new Promise<void>((resolve) =>
        cli.stdout.once("close", () => resolve()),
      );
      cli.stdout.resume();
      yield* recorded;
      cli.stdin.end("go\n");
      yield* forgotten;
      yield* Effect.promise(() => stdoutClosed);

      expect(yield* fs.readDirectory(path.join(stateDir, "provider-processes"))).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports the exit even while a process outside its group holds stderr open", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-process-" });
      const { factory, recorded } = yield* makeFactory(stateDir, process.pid);
      const claudeCode = factory();

      // Like a tool command in its own session that inherited the CLI's stderr.
      const holdStderr = `"${process.execPath}" -e 'require("node:child_process").spawn("sleep", ["2"], { detached: true, stdio: ["ignore", "ignore", "inherit"] }).unref()'`;
      const cli = yield* spawnCli(claudeCode, `read line; echo boom >&2; ${holdStderr}; exit 3`);
      yield* recorded;
      const sdkSawExit = new Promise<void>((resolve) => cli.once("exit", () => resolve()));
      cli.stdin.end("go\n");
      yield* Effect.promise(() => sdkSawExit);

      const error = claudeCode.withStderr(new Error("Claude Code process exited with code 3"));
      expect((error as Error).message).toBe("Claude Code process exited with code 3. stderr: boom");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
