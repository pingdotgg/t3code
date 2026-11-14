import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProcessRunner from "../processRunner.ts";
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

const makeService = (env: Record<string, string> = { T3CODE_SOURCE_CHECKOUT: CHECKOUT }) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const launches: Array<ThreadLaunch.ThreadLaunchInput> = [];
  const bootstraps: Array<ProjectService.ProjectBootstrapInput> = [];
  const layer = SourceUpdateService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) => {
            calls.push([input.command, ...input.args]);
            const args = input.args.join(" ");
            if (input.command === "systemctl") return Effect.succeed(output("inactive\n", 3));
            if (input.command === "systemd-run") return Effect.succeed(output(""));
            if (args.includes("log -1")) return Effect.succeed(output("abc1234\0Add a thing\n"));
            if (args.includes("HEAD..origin/main")) return Effect.succeed(output("3\n"));
            if (args.includes("HEAD..upstream/main")) return Effect.succeed(output("", 128));
            return Effect.succeed(output(""));
          },
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
  return { calls, launches, bootstraps, layer };
};

describe("SourceUpdateService", () => {
  it("reads the last outcome line the update script wrote", () => {
    assert.deepEqual(
      SourceUpdateService.parseLastSourceUpdateResult(
        [
          "[source-update] failed 2026-01-01T00:00:00Z Old failure",
          "Already up to date.",
          "[source-update] succeeded 2026-01-02T00:00:00Z Updated to abc1234 Add a thing",
          "",
        ].join("\n"),
      ),
      {
        outcome: "succeeded",
        finishedAt: "2026-01-02T00:00:00.000Z",
        message: "Updated to abc1234 Add a thing",
      },
    );
    assert.isNull(SourceUpdateService.parseLastSourceUpdateResult("Updating /src\n"));
  });

  it.effect("is unavailable without a source checkout", () => {
    const { layer } = makeService({});
    return Effect.gen(function* () {
      const service = yield* SourceUpdateService.SourceUpdateService;
      const error = yield* Effect.flip(service.status);
      assert.equal(error.reason, "unavailable");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports HEAD and how far each remote moved, null for a missing remote", () => {
    const { layer, calls } = makeService();
    return Effect.gen(function* () {
      const service = yield* SourceUpdateService.SourceUpdateService;
      const status = yield* service.status;
      assert.deepEqual(status.head, { sha: "abc1234", subject: "Add a thing" });
      assert.equal(status.behindOrigin, 3);
      assert.isNull(status.upstreamAhead);
      assert.isFalse(status.updateRunning);
      assert.isNull(status.lastResult);
      yield* service.status;
      assert.equal(calls.filter((call) => call.includes("fetch")).length, 2);
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
      assert.isFalse(calls.some((call) => call[0] === "systemd-run"));

      yield* service.update({ force: true });
      const started = calls.find((call) => call[0] === "systemd-run");
      assert.isDefined(started);
      assert.include(started, "t3code-source-update");
      assert.equal(started?.at(-1), `${CHECKOUT}/scripts/self-update.sh`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("starts a Claude thread in the checkout's project to merge upstream", () => {
    const { layer, launches, bootstraps } = makeService();
    return Effect.gen(function* () {
      const service = yield* SourceUpdateService.SourceUpdateService;
      const result = yield* service.pullUpstream;
      assert.deepEqual(result, { projectId, threadId });
      assert.equal(bootstraps[0]?.workspaceRoot, CHECKOUT);
      assert.equal(launches.length, 1);
      assert.equal(launches[0]?.projectId, projectId);
      assert.equal(launches[0]?.modelSelection.instanceId, "claudeAgent");
      assert.equal(launches[0]?.initialMessage?.text, SourceUpdateService.PULL_UPSTREAM_PROMPT);
    }).pipe(Effect.provide(layer));
  });
});
