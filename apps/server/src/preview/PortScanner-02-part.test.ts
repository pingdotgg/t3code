// @effect-diagnostics nodeBuiltinImport:off -- the stop test drives real server processes.
import * as NodeChildProcess from "node:child_process";

import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  type DiscoveredLocalServer,
} from "@t3tools/contracts";
import * as ProcessGroup from "@t3tools/provider-core/server/processGroup";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";
import { FetchHttpClient } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";

vi.mock("@t3tools/provider-core/server/processGroup", { spy: true });


















/**
 * A real HTML server with an agent's environment, started the way an agent's tool shell starts a
 * job: under a detached shell with job control, in a group of its own. Release kills only the pids
 * it started.
 */

import { processProbeFailure, layerNoProc, layerProbeFailure, LSOF_TEST_PORT, processOutput, ownedScanner, layerLsofScanner, AGENT_SERVER_SCRIPT, agentServer, isRunning } from "./PortScanner-fixtures.testkit.ts";
effectIt.effect.each(["linux", "darwin"] as const)(
  "attributes listeners to the agent thread in their environment on %s, after the agent exits",
  (platform) => {
    const agentPort = 43_124;
    const otherPort = 43_125;
    const agentListener = `p4242\ncnode\nn127.0.0.1:${agentPort}\n`;
    const otherListener = `p5000\ncpostgres\nn127.0.0.1:${otherPort}\n`;
    let lsofStdout = otherListener;
    let lsofFails = false;
    let environmentFails = false;
    let lsofCalls = 0;
    let environmentReads = 0;
    const requests: string[] = [];
    const missing = FileSystem.makeNoop({});
    const procEnviron: Record<string, string> = {
      "/proc/4242/environ": `PATH=/usr/bin\0${PortScanner.AGENT_THREAD_ENV}=thread-agent\0`,
      "/proc/5000/environ": "PATH=/usr/bin\0",
    };
    const layer = PortScanner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            readFileString: (path) => {
              const content = procEnviron[path];
              if (content === undefined) return missing.readFileString(path);
              environmentReads += 1;
              return Effect.succeed(content);
            },
          }),
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: (input) => {
              if (input.command === "lsof") {
                lsofCalls += 1;
                return lsofFails
                  ? Effect.fail(
                      new ProcessRunner.ProcessTimeoutError({
                        command: input.command,
                        argumentCount: input.args.length,
                        cwd: input.cwd,
                        timeoutMs: 5_000,
                      }),
                    )
                  : Effect.succeed(processOutput(lsofStdout));
              }
              // A direct child of this process, so stop refuses it without signaling anything.
              if (input.args[0] === "-A") {
                return Effect.succeed(processOutput(`4242 ${process.pid} 4242\n`));
              }
              if (environmentFails) {
                return Effect.fail(
                  new ProcessRunner.ProcessTimeoutError({
                    command: input.command,
                    argumentCount: input.args.length,
                    timeoutMs: 5_000,
                  }),
                );
              }
              environmentReads += 1;
              return Effect.succeed(
                processOutput(
                  `  4242 node server.js PATH=/usr/bin ${PortScanner.AGENT_THREAD_ENV}=thread-agent HOME=/Users/dev\n` +
                    "  5000 postgres -D /data PATH=/usr/bin\n",
                ),
              );
            },
          }),
          Layer.succeed(HostProcess.Platform, platform),
          FetchHttpClient.layer.pipe(
            Layer.provide(
              Layer.succeed(FetchHttpClient.Fetch, (input) => {
                requests.push(String(input));
                return Promise.resolve(
                  new Response("app", { headers: { "content-type": "text/html" } }),
                );
              }),
            ),
          ),
        ),
      ),
    );

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      // Startup reads listeners once. With none marked, later scans stay idle.
      expect(yield* scanner.scan()).toEqual([]);
      expect(yield* scanner.scan()).toEqual([]);
      expect(lsofCalls).toBe(1);

      // The agent exits before any client looks, and the first read fails; its server is still
      // found.
      lsofStdout = `${agentListener}${otherListener}`;
      scanner.trackAgent()();
      lsofFails = true;
      expect(yield* scanner.scan()).toEqual([]);
      lsofFails = false;
      if (platform === "darwin") {
        environmentFails = true;
        expect(yield* scanner.scan()).toEqual([]);
        environmentFails = false;
      }
      expect(yield* scanner.scan()).toMatchObject([
        { port: agentPort, pid: 4242, terminal: null, agent: { threadId: "thread-agent" } },
      ]);
      expect(requests).toEqual([]);

      expect(yield* scanner.scan()).toHaveLength(1);
      expect(environmentReads).toBe(2);

      // Stop reads its target's environment again rather than trust the cache, and still finds it.
      const stop = yield* Effect.flip(scanner.stopServer({ pid: 4242, port: agentPort }));
      expect(stop.reason).toBe("shared-group");
      expect(environmentReads).toBe(3);

      lsofStdout = otherListener;
      expect(yield* scanner.scan()).toEqual([]);
      const lsofCallsAfterExit = lsofCalls;
      expect(yield* scanner.scan()).toEqual([]);
      expect(lsofCalls).toBe(lsofCallsAfterExit);
    }).pipe(Effect.provide(layer));
  },
);
effectIt.effect("stops only a job's own process group", () =>
  Effect.sync(() => {
    const serverPid = 100;
    const rows = [
      { pid: 10, ppid: 1, pgid: 10 }, // `vp run dev`, whose job holds this server
      { pid: 20, ppid: 10, pgid: 10 }, // the web dev server in the same job
      { pid: serverPid, ppid: 10, pgid: 10 },
      { pid: 200, ppid: serverPid, pgid: 200 }, // agent CLI
      { pid: 210, ppid: 200, pgid: 200 }, // a server it spawned without a group of its own
      { pid: 300, ppid: 200, pgid: 300 }, // agent tool shell
      { pid: 400, ppid: 300, pgid: 400 }, // `npm run dev &`
      { pid: 401, ppid: 400, pgid: 400 },
      { pid: 500, ppid: serverPid, pgid: 500 }, // terminal shell
      { pid: 600, ppid: 500, pgid: 600 }, // terminal job
    ];
    const table = new Map(rows.map((row) => [row.pid, row]));
    expect(PortScanner.stoppableProcessGroup(table, 401, serverPid)).toBe(400);
    expect(PortScanner.stoppableProcessGroup(table, 600, serverPid)).toBe(600);
    for (const pid of [20, 210, 500, 999]) {
      expect(PortScanner.stoppableProcessGroup(table, pid, serverPid)).toBeNull();
    }
  }),
);
effectIt.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "stops an agent's server through its job's group, and only a listed server",
  () =>
    Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* Effect.acquireRelease(Effect.sync(scanner.trackAgent), (release) =>
        Effect.sync(release),
      );
      const job = yield* agentServer();

      expect(yield* scanner.scan()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pid: job.pid,
            port: job.port,
            agent: { threadId: "thread-live" },
          }),
        ]),
      );

      const unlisted = yield* Effect.flip(scanner.stopServer({ pid: process.pid, port: job.port }));
      expect(unlisted.reason).toBe("not-found");

      yield* scanner.stopServer({ pid: job.pid, port: job.port });
      // The shell waits on its job, so it exits once the job has.
      yield* Effect.promise(() => job.exited);
      expect(isRunning(job.pid)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        PortScanner.layer.pipe(
          Layer.provide(ProcessRunner.layer),
          Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
        ),
      ),
    ),
);
