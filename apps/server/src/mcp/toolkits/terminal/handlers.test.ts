import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  TerminalSessionSnapshot,
  TerminalSummary,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Option, Schedule, Schema, Sink, Stream } from "effect";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeTerminalManagerWithOptions } from "../../../terminal/Layers/Manager.ts";
import * as NodePTY from "../../../terminal/Layers/NodePTY.ts";
import { TerminalManager } from "../../../terminal/Services/Manager.ts";
import { PtyAdapter } from "../../../terminal/Services/PTY.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { TerminalToolkitHandlersLive } from "./handlers.ts";
import { TerminalToolkit } from "./tools.ts";

const threadId = ThreadId.make("terminal-owner");
const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("terminal-test"),
  threadId,
  providerSessionId: "provider-session",
  providerInstanceId: ProviderInstanceId.make("copilot"),
  capabilities: new Set(["terminal"]),
  issuedAt: 1,
};

const last = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption));
const snapshot = Schema.decodeUnknownSync(TerminalSessionSnapshot);
const summaries = Schema.decodeUnknownSync(
  Schema.Struct({ terminals: Schema.Array(TerminalSummary) }),
);

it.live(
  "keeps a real server alive after tool completion, isolates ownership, and stops it explicitly",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped().pipe(Effect.flatMap(fs.realPath));
      const ptyAdapter = yield* PtyAdapter;
      const manager = yield* makeTerminalManagerWithOptions({
        logsDir: `${cwd}/logs`,
        ptyAdapter,
        shellResolver: () => (process.platform === "win32" ? "cmd.exe" : "/bin/sh"),
      });
      const projections = Layer.mock(ProjectionSnapshotQuery)({
        getThreadCheckpointContext: () =>
          Effect.succeed(
            Option.some({
              threadId,
              projectId: ProjectId.make("terminal-project"),
              workspaceRoot: "/not-the-worktree",
              worktreePath: cwd,
              checkpoints: [],
            }),
          ),
      });
      yield* Effect.gen(function* () {
        const toolkit = yield* TerminalToolkit;
        const denied = yield* toolkit
          .handle("terminal_start", { command: "echo must-not-run" })
          .pipe(
            Stream.unwrap,
            last,
            Effect.provideService(McpInvocationContext, {
              ...invocation,
              capabilities: new Set<"terminal">(),
            }),
            Effect.result,
          );
        assert.strictEqual(denied._tag, "Failure");
        if (denied._tag === "Failure") {
          assert.include(String(denied.failure), "not available");
        }
        const source =
          "require('node:http').createServer((q,s)=>s.end(process.cwd()))" +
          ".listen(0,'127.0.0.1',function(){console.log('SERVER_PORT='+this.address().port)})";
        const command =
          process.platform === "win32"
            ? `"${process.execPath}" -e "${source}"`
            : `case "$-" in *i*) echo INTERACTIVE_SHELL_UNSAFE; exit 47;; esac; '${process.execPath.replaceAll("'", "'\\''")}' -e '${source.replaceAll("'", "'\\''")}'`;
        const started = yield* toolkit
          .handle("terminal_start", { command })
          .pipe(Stream.unwrap, last, Effect.scoped);
        assert.isFalse(started.isFailure);
        const terminalId = snapshot(started.result).terminalId;
        assert.strictEqual(snapshot(started.result).cwd, cwd);
        const openedInClient = yield* manager.open({
          threadId,
          terminalId,
          cwd,
          worktreePath: cwd,
          env: projectScriptRuntimeEnv({
            project: { cwd: "/not-the-worktree" },
            worktreePath: cwd,
          }),
        });
        assert.strictEqual(openedInClient.pid, snapshot(started.result).pid);

        const read = () =>
          toolkit.handle("terminal_read", { terminalId }).pipe(
            Stream.unwrap,
            last,
            Effect.map((response) => snapshot(response.result)),
            Effect.scoped,
          );
        const ready = yield* read().pipe(
          Effect.filterOrFail(
            (result) => /SERVER_PORT=\d+/.test(result.history),
            () => new Error("Server has not announced its port"),
          ),
          Effect.retry(Schedule.spaced("50 millis")),
          Effect.timeout("10 seconds"),
        );
        const port = /SERVER_PORT=(\d+)/.exec(ready.history)?.[1];
        assert.isDefined(port);
        const url = `http://127.0.0.1:${port}`;
        const response = yield* Effect.promise(() => fetch(url).then((r) => r.text()));
        assert.strictEqual(response, cwd);

        const retained = yield* toolkit.handle("terminal_list", {}).pipe(Stream.unwrap, last);
        assert.isFalse(retained.isFailure);
        assert.deepStrictEqual(
          summaries(retained.result).terminals.map((terminal) => terminal.terminalId),
          [terminalId],
        );

        const foreignScope = { ...invocation, threadId: ThreadId.make("other-thread") };
        const foreignRead = yield* read().pipe(
          Effect.provideService(McpInvocationContext, foreignScope),
          Effect.result,
        );
        assert.strictEqual(foreignRead._tag, "Failure");
        if (foreignRead._tag === "Failure") {
          assert.include(String(foreignRead.failure), "Unknown terminal");
        }
        const foreignStop = yield* toolkit
          .handle("terminal_stop", { terminalId })
          .pipe(
            Stream.unwrap,
            last,
            Effect.provideService(McpInvocationContext, foreignScope),
            Effect.result,
          );
        assert.strictEqual(foreignStop._tag, "Failure");
        if (foreignStop._tag === "Failure") {
          assert.include(String(foreignStop.failure), "Unknown terminal");
        }
        assert.strictEqual(yield* Effect.promise(() => fetch(url).then((r) => r.text())), cwd);

        const stopped = yield* toolkit
          .handle("terminal_stop", { terminalId })
          .pipe(Stream.unwrap, last);
        assert.isFalse(stopped.isFailure);
        yield* Effect.promise(() =>
          fetch(url).then(
            () => false,
            () => true,
          ),
        ).pipe(
          Effect.filterOrFail(Boolean, () => new Error("Server is still reachable")),
          Effect.retry(Schedule.spaced("50 millis")),
          Effect.timeout("10 seconds"),
        );
        const afterStop = yield* Effect.result(read());
        assert.strictEqual(afterStop._tag, "Failure");

        const listed = yield* toolkit.handle("terminal_list", {}).pipe(Stream.unwrap, last);
        assert.isFalse(listed.isFailure);
        if (!listed.isFailure) assert.deepStrictEqual(listed.result, { terminals: [] });

        const finite = yield* toolkit
          .handle("terminal_start", { command: "exit 0" })
          .pipe(Stream.unwrap, last);
        const finiteId = snapshot(finite.result).terminalId;
        yield* toolkit.handle("terminal_read", { terminalId: finiteId }).pipe(
          Stream.unwrap,
          last,
          Effect.filterOrFail(
            (result) => snapshot(result.result).status === "exited",
            () => new Error("Finite command has not exited"),
          ),
          Effect.retry(Schedule.spaced("50 millis")),
          Effect.timeout("10 seconds"),
        );
        const reopened = yield* manager.open({
          threadId,
          terminalId: finiteId,
          cwd,
          worktreePath: cwd,
          env: projectScriptRuntimeEnv({
            project: { cwd: "/not-the-worktree" },
            worktreePath: cwd,
          }),
        });
        assert.strictEqual(reopened.status, "exited");
        assert.strictEqual(reopened.exitCode, 0);
      }).pipe(
        Effect.provide(TerminalToolkitHandlersLive.pipe(Layer.provideMerge(projections))),
        Effect.provideService(TerminalManager, manager),
        Effect.provideService(McpInvocationContext, invocation),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(NodePTY.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  { timeout: 30_000 },
);
