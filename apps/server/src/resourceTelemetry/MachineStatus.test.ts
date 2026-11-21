import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HostResources from "./HostResources.ts";
import * as MachineStatus from "./MachineStatus.ts";

const GiB = 1024 ** 3;

const layerTest = MachineStatus.layer.pipe(
  Layer.provide(
    Layer.mock(HostResources.HostResources)({
      read: Effect.succeed({
        sampledAt: 0,
        cpuUtilization: 0.25,
        cpuCount: 4,
        availableMemoryBytes: 2 * GiB,
        totalMemoryBytes: 4 * GiB,
      }),
    }),
  ),
  Layer.provide(ServerSettings.layerTest({ machineStatus: { maxWorkingAgents: 2 } })),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-machine-status-test-" })),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(NodeServices.layer),
);

const seed = Effect.fn("seed")(function* (
  threads: ReadonlyArray<{
    readonly id: string;
    readonly minute: number;
    readonly deleted?: boolean;
    readonly runs?: ReadonlyArray<string>;
    /** A session status, and whether the thread is bound only through the bindings table. */
    readonly session?: { readonly status: string; readonly boundOnly?: boolean };
  }>,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const thread of threads) {
    const at = `2026-11-21T10:${String(thread.minute).padStart(2, "0")}:00.000Z`;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at, payload_json
      ) VALUES (
        ${thread.id}, 'project', ${`Title ${thread.id}`}, 'codex', 'full-access', 'default',
        ${at}, ${at}, ${thread.deleted ? at : null}, '{}'
      )
    `;
    for (const [ordinal, status] of (thread.runs ?? []).entries()) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json
        ) VALUES (
          ${`${thread.id}:${ordinal}`}, ${thread.id}, ${ordinal}, 'claudeAgent', 'claudeAgent',
          ${status}, ${at}, '{}'
        )
      `;
    }
    if (thread.session) {
      const sessionId = `session:${thread.id}`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_sessions (
          provider_session_id, thread_id, provider, driver, provider_instance_id, status,
          updated_at, payload_json
        ) VALUES (
          ${sessionId}, ${thread.session.boundOnly ? null : thread.id}, 'codex', 'codex', 'codex',
          ${thread.session.status}, ${at}, '{}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_session_bindings (provider_session_id, thread_id)
        VALUES (${sessionId}, ${thread.id})
      `;
    }
  }
});

describe("MachineStatusReader", () => {
  it.effect("counts threads with an active run as working and idle live sessions as open", () =>
    Effect.gen(function* () {
      yield* seed([
        { id: "running", minute: 1, runs: ["completed", "running", "queued"] },
        { id: "queued", minute: 2, runs: ["queued"] },
        { id: "preparing-child", minute: 3, runs: ["preparing"] },
        { id: "waiting", minute: 4, runs: ["waiting"], session: { status: "waiting" } },
        { id: "idle", minute: 5, runs: ["completed"], session: { status: "ready" } },
        { id: "bound", minute: 6, session: { status: "ready", boundOnly: true } },
        { id: "stopped", minute: 7, runs: ["completed"], session: { status: "stopped" } },
        { id: "failed", minute: 8, runs: ["failed"], session: { status: "error" } },
        { id: "deleted", minute: 9, deleted: true, runs: ["running"] },
      ]);
      const status = yield* (yield* MachineStatus.MachineStatusReader).read;

      assert.deepStrictEqual(
        status.agents.map(({ threadId, state, providerInstanceId }) => ({
          threadId: String(threadId),
          state,
          providerInstanceId: providerInstanceId === null ? null : String(providerInstanceId),
        })),
        [
          { threadId: "preparing-child", state: "working", providerInstanceId: "claudeAgent" },
          { threadId: "queued", state: "working", providerInstanceId: "claudeAgent" },
          { threadId: "running", state: "working", providerInstanceId: "claudeAgent" },
          { threadId: "bound", state: "open", providerInstanceId: "codex" },
          { threadId: "idle", state: "open", providerInstanceId: "codex" },
          { threadId: "waiting", state: "open", providerInstanceId: "codex" },
        ],
      );
      assert.strictEqual(status.working, 3);
      assert.strictEqual(status.open, 3);
      assert.strictEqual(status.agents[0]?.title, "Title preparing-child");
      assert.strictEqual(status.maxWorkingAgents, 2);
      assert.strictEqual(status.cpuUtilization, 0.25);
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("parseMeminfo", () => {
  it("reads memory and swap in bytes", () => {
    const meminfo = [
      "MemTotal:        7522760 kB",
      "MemFree:          264852 kB",
      "MemAvailable:    4800888 kB",
      "SwapTotal:       7954428 kB",
      "SwapFree:        7354428 kB",
    ].join("\n");
    assert.deepStrictEqual(MachineStatus.parseMeminfo(meminfo), {
      memory: { totalBytes: 7522760 * 1024, availableBytes: 4800888 * 1024 },
      swap: { totalBytes: 7954428 * 1024, usedBytes: 600000 * 1024 },
    });
  });

  it("gives up without MemAvailable", () => {
    assert.strictEqual(MachineStatus.parseMeminfo("MemTotal:        7522760 kB\n"), null);
  });
});

describe("parsePressure", () => {
  it("reads the some line", () => {
    assert.deepStrictEqual(
      MachineStatus.parsePressure(
        "some avg10=3.92 avg60=2.02 avg300=1.67 total=322035421\nfull avg10=3.33 avg60=1.84 avg300=1.52 total=264998880\n",
      ),
      { avg10: 3.92, avg60: 2.02 },
    );
  });

  it("gives up on an empty file", () => {
    assert.strictEqual(MachineStatus.parsePressure(""), null);
  });
});
