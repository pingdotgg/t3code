import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceUpdateService from "./SourceUpdateService.ts";

const CHECKOUT = "/src/t3code";
const projectId = ProjectId.make("source-project");
const threadId = ThreadId.make("merge-thread");

const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code as ProcessRunner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const claude: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const makeService = (
  options: {
    readonly env?: Record<string, string>;
    readonly unitActive?: boolean;
    readonly systemd?: boolean;
    readonly providers?: ReadonlyArray<ServerProvider>;
    readonly upstreamConflicts?: boolean;
    /** Every fetch waits on this, so a test can hold one in flight. */
    readonly fetchGate?: Deferred.Deferred<void>;
  } = {},
) => {
  const env = options.env ?? { T3CODE_SOURCE_CHECKOUT: CHECKOUT };
  const calls: Array<ReadonlyArray<string>> = [];
  const launches: Array<ThreadLaunch.ThreadLaunchInput> = [];
  const bootstraps: Array<ProjectService.ProjectBootstrapInput> = [];
  const fetchStarted = Deferred.makeUnsafe<void>();
  const layer = SourceUpdateService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) => {
            calls.push([input.command, ...input.args]);
            const args = input.args.join(" ");
            if (input.command === "systemd-run" && args === "--version") {
              return Effect.succeed(output("", options.systemd === false ? 1 : 0));
            }
            if (input.command === "systemctl" && args.includes("show")) {
              return Effect.succeed(output("Version=256\n", options.systemd === false ? 1 : 0));
            }
            if (input.command === "systemctl" && args.includes("is-active")) {
              return Effect.succeed(
                options.unitActive === true ? output("active\n") : output("inactive\n", 3),
              );
            }
            if (input.command === "systemctl" || input.command === "systemd-run") {
              return Effect.succeed(output(""));
            }
            if (args.includes(" fetch ")) {
              return Deferred.succeed(fetchStarted, undefined).pipe(
                Effect.andThen(options.fetchGate ? Deferred.await(options.fetchGate) : Effect.void),
                Effect.as(output("")),
              );
            }
            if (args.includes("merge-tree")) {
              return Effect.succeed(output("tree\n", options.upstreamConflicts === true ? 1 : 0));
            }
            if (args.includes("log -1")) return Effect.succeed(output("abc1234\0Add a thing\n"));
            if (args.includes("HEAD..origin/main")) return Effect.succeed(output("3\n"));
            if (args.includes("HEAD..upstream/main")) return Effect.succeed(output("", 128));
            if (args.includes("rev-parse HEAD")) return Effect.succeed(output("built0\n"));
            if (args.includes("built0..HEAD")) return Effect.succeed(output("2\n"));
            return Effect.succeed(output(""));
          },
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(options.providers ?? [claude]),
        }),
        Layer.mock(ProjectService.ProjectService)({
          bootstrap: (input) => {
            bootstraps.push(input);
            return Effect.succeed({
              created: true,
              project: {
                id: projectId,
                title: "t3code",
                workspaceRoot: input.workspaceRoot,
                repositoryIdentity: null,
                faviconPath: null,
                scripts: [],
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                deletedAt: null,
                defaultModelSelection: null,
              },
            });
          },
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) => {
            launches.push(input);
            return Effect.succeed({ threadId, resumed: false } as ThreadLaunch.ThreadLaunchResult);
          },
        }),
        ServerSettings.layerTest(),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-update-" }),
        Layer.fresh(SqlitePersistence.layerMemory),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return { calls, launches, bootstraps, fetchStarted, layer };
};

const fetchCalls = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter((call) => call.includes("fetch")).length;

describe("SourceUpdateService", () => {
  it("reads the logged run and only its own outcome", () => {
    assert.deepEqual(
      SourceUpdateService.parseSourceUpdateLog(
        [
          "[source-update] started run-1",
          "Already up to date.",
          "[source-update] succeeded run-1 2026-01-02T00:00:00Z Updated to abc1234 Add a thing",
          "",
        ].join("\n"),
      ),
      {
        lastRunId: "run-1",
        lastResult: {
          runId: "run-1",
          outcome: "succeeded",
          finishedAt: "2026-01-02T00:00:00.000Z",
          message: "Updated to abc1234 Add a thing",
        },
      },
    );
    assert.deepEqual(SourceUpdateService.parseSourceUpdateLog("[source-update] started run-2\n"), {
      lastRunId: "run-2",
      lastResult: null,
    });
    // The format before run ids, still in the log of a server that just updated to this one.
    assert.deepEqual(
      SourceUpdateService.parseSourceUpdateLog(
        "[source-update] succeeded 2026-01-02T00:00:00Z Updated to abc1234 Add a thing\n",
      ),
      { lastRunId: null, lastResult: null },
    );
  });

  it.each([
    ["0::/user.slice/user-1000.slice/user@1000.service/app.slice/t3code.service", true],
    ["0::/user.slice/user-1000.slice/user@1000.service/app.slice/t3code-dev.service", false],
    ["0::/user.slice/user-1000.slice/session-2.scope", false],
  ])("finds the unit in %s: %s", (cgroup, inside) => {
    assert.equal(SourceUpdateService.runsInSystemdUnit(cgroup, "t3code"), inside);
  });

  it.effect("is unavailable without a source checkout", () => {
    const { layer } = makeService({ env: {} });
    return Effect.gen(function* () {
      const service = yield* SourceUpdateService.SourceUpdateService;
      const error = yield* Effect.flip(service.status);
      assert.equal(error.reason, "unavailable");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "reports HEAD, how far each remote and the running build lag it, null for a missing remote",
    () => {
      const { layer } = makeService();
      return Effect.gen(function* () {
        const service = yield* SourceUpdateService.SourceUpdateService;
        const status = yield* service.status;
        assert.deepEqual(status.head, { sha: "abc1234", subject: "Add a thing" });
        assert.equal(status.behindOrigin, 3);
        assert.isNull(status.upstreamAhead);
        assert.equal(status.unbuiltCommits, 2);
        assert.isFalse(status.updateRunning);
        assert.isNull(status.lastRunId);
        assert.isNull(status.lastResult);
        assert.isNull(status.updateUnavailableReason);
        assert.isNull(status.pullUpstreamUnavailableReason);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("answers status without waiting on the remote fetch, and runs one at a time", () => {
    const fetchGate = Deferred.makeUnsafe<void>();
    const { layer, calls, fetchStarted } = makeService({ fetchGate });
    return Effect.gen(function* () {
      const service = yield* SourceUpdateService.SourceUpdateService;
      yield* service.status;
      yield* Deferred.await(fetchStarted);
      yield* service.status;
      assert.equal(fetchCalls(calls), 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not fetch while an update runs", () => {
    const { layer, calls } = makeService({ unitActive: true });
    return Effect.gen(function* () {
      const service = yield* SourceUpdateService.SourceUpdateService;
      const status = yield* service.status;
      assert.isTrue(status.updateRunning);
      assert.equal(fetchCalls(calls), 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to update while a turn runs unless forced", () => {
    const { layer, calls } = makeService();
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('run-1', 'thread-1', 1, 'claudeAgent', 'running', '2026-01-01T00:00:00Z', '{}')
      `;
      const service = yield* SourceUpdateService.SourceUpdateService;
      const error = yield* Effect.flip(service.update({}));
      assert.equal(error.reason, "turns-running");
      assert.isFalse(calls.some((call) => call[0] === "systemd-run" && call.includes("--unit")));

      const result = yield* service.update({ force: true });
      assert.isTrue("runId" in result);
      const runId = "runId" in result ? result.runId : "";
      const startedAt = calls.findIndex(
        (call) => call[0] === "systemd-run" && call.includes("--unit"),
      );
      const started = calls[startedAt];
      assert.isDefined(started);
      // Upstream merged cleanly against what the script will fast-forward to, so the script runs.
      const checkedAt = calls.findIndex(
        (call) =>
          call.join(" ") === `git -C ${CHECKOUT} merge-tree --write-tree origin/main upstream/main`,
      );
      assert.isTrue(checkedAt !== -1 && checkedAt < startedAt);
      assert.isTrue(calls.slice(0, checkedAt).some((call) => call.includes("fetch")));
      assert.include(started, "t3code-source-update");
      assert.include(started, `--setenv=T3CODE_SOURCE_UPDATE_RUN_ID=${runId}`);
      assert.include(started, "RuntimeMaxSec=1800");
      assert.isTrue(
        started?.some((arg) => arg.startsWith("--setenv=T3CODE_SOURCE_UPDATE_SERVICE=")),
      );
      assert.equal(started?.at(-1), `${CHECKOUT}/scripts/self-update.sh`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("runs a configured update command with its arguments", () => {
    const { layer, calls } = makeService({
      env: {
        T3CODE_SOURCE_CHECKOUT: CHECKOUT,
        T3CODE_SOURCE_UPDATE_COMMAND: `"/opt/my tools/update.sh" --fast`,
      },
    });
    return Effect.gen(function* () {
      const service = yield* SourceUpdateService.SourceUpdateService;
      yield* service.update({});
      const started = calls.find((call) => call[0] === "systemd-run" && call.includes("--unit"));
      assert.deepEqual(started?.slice(-2), ["/opt/my tools/update.sh", "--fast"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("offers no Update without systemd and refuses to start one", () => {
    const { layer, calls } = makeService({ systemd: false });
    return Effect.gen(function* () {
      const service = yield* SourceUpdateService.SourceUpdateService;
      const status = yield* service.status;
      assert.isNotNull(status.updateUnavailableReason);
      const error = yield* Effect.flip(service.update({}));
      assert.equal(error.reason, "unavailable");
      assert.isFalse(calls.some((call) => call.includes("--unit")));
    }).pipe(Effect.provide(layer));
  });

  it.effect("cancels a running update by stopping its unit", () => {
    const { layer, calls } = makeService({ unitActive: true });
    return Effect.gen(function* () {
      const service = yield* SourceUpdateService.SourceUpdateService;
      yield* service.cancel;
      assert.isTrue(
        calls.some((call) => call.join(" ") === "systemctl --user stop t3code-source-update"),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports the run in the log and its outcome", () => {
    const { layer } = makeService();
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(config.logsDir, { recursive: true });
      yield* fs.writeFileString(
        `${config.logsDir}/source-update.log`,
        "[source-update] started run-7\n[source-update] failed run-7 2026-01-02T00:00:00Z Broke\n",
      );
      const service = yield* SourceUpdateService.SourceUpdateService;
      const status = yield* service.status;
      assert.equal(status.lastRunId, "run-7");
      assert.equal(status.lastResult?.outcome, "failed");
      assert.equal(status.lastResult?.message, "Broke");
    }).pipe(Effect.provide(layer));
  });

  it.effect("hands conflicting upstream to a Claude thread instead of running the script", () => {
    const { layer, calls, launches, bootstraps } = makeService({ upstreamConflicts: true });
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Nothing restarts, so a running turn does not block it.
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('run-1', 'thread-1', 1, 'claudeAgent', 'running', '2026-01-01T00:00:00Z', '{}')
      `;
      const service = yield* SourceUpdateService.SourceUpdateService;
      const result = yield* service.update({});
      assert.deepEqual(result, { upstreamConflict: { projectId, threadId } });
      assert.isFalse(calls.some((call) => call[0] === "systemd-run" && call.includes("--unit")));
      assert.equal(bootstraps[0]?.workspaceRoot, CHECKOUT);
      assert.equal(launches.length, 1);
      assert.equal(launches[0]?.projectId, projectId);
      assert.equal(launches[0]?.modelSelection.instanceId, "claudeAgent");
      assert.equal(launches[0]?.initialMessage?.text, SourceUpdateService.PULL_UPSTREAM_PROMPT);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses conflicting upstream without a working Claude provider", () => {
    const { layer, calls, launches } = makeService({
      upstreamConflicts: true,
      providers: [{ ...claude, installed: false }],
    });
    return Effect.gen(function* () {
      const service = yield* SourceUpdateService.SourceUpdateService;
      const status = yield* service.status;
      assert.equal(
        status.pullUpstreamUnavailableReason,
        "Claude Code is not installed on this server.",
      );
      const error = yield* Effect.flip(service.update({}));
      assert.equal(error.reason, "unavailable");
      assert.equal(launches.length, 0);
      assert.isFalse(calls.some((call) => call[0] === "systemd-run" && call.includes("--unit")));
    }).pipe(Effect.provide(layer));
  });
});
