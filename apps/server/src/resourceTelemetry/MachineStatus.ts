// @effect-diagnostics nodeBuiltinImport:off - host name, load averages and disk space have no Effect API.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import {
  type MachineAgent,
  type MachinePressure,
  type MachineStatus,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { HostResources } from "./HostResources.ts";

export class MachineStatusReader extends Context.Service<
  MachineStatusReader,
  { readonly read: Effect.Effect<MachineStatus> }
>()("t3/resourceTelemetry/MachineStatus/MachineStatusReader") {}

const MAX_LISTED_AGENTS = 12;

/** Memory and swap from `/proc/meminfo`, in bytes; null without MemTotal and MemAvailable. */
export function parseMeminfo(meminfo: string) {
  const bytes = (field: string) => {
    const kib = new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(meminfo)?.[1];
    return kib === undefined ? null : Number(kib) * 1024;
  };
  const totalBytes = bytes("MemTotal");
  const availableBytes = bytes("MemAvailable");
  if (totalBytes === null || availableBytes === null) return null;
  const swapTotal = bytes("SwapTotal");
  const swapFree = bytes("SwapFree");
  return {
    memory: { totalBytes, availableBytes },
    swap:
      swapTotal === null || swapFree === null
        ? null
        : { totalBytes: swapTotal, usedBytes: Math.max(0, swapTotal - swapFree) },
  };
}

/** The `some` line of a `/proc/pressure/*` file. */
export function parsePressure(text: string): MachinePressure | null {
  const match = /^some avg10=(\d+(?:\.\d+)?) avg60=(\d+(?:\.\d+)?)/m.exec(text);
  return match ? { avg10: Number(match[1]), avg60: Number(match[2]) } : null;
}

const AgentRow = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  working: Schema.Number,
  providerInstanceId: Schema.NullOr(Schema.String),
});
const isProviderInstanceId = Schema.is(ProviderInstanceId);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const hostResources = yield* HostResources;
  const settings = yield* ServerSettingsService;
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;

  const readFile = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));

  // Working: a run that is preparing, starting or running. A queued run on an idle thread
  // waits on a hold, a usage limit or the user, so it runs no agent. Open: a live session
  // still bound to the thread; detaching removes the binding but not `sessions.thread_id`.
  // The status list repeats the partial recovery index's predicate so SQLite can use it.
  const readAgents = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AgentRow,
    execute: () => sql`
      WITH working_runs AS (
        SELECT thread_id, provider_instance_id, MIN(ordinal)
        FROM orchestration_v2_projection_runs
        WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
          AND status IN ('preparing', 'starting', 'running')
        GROUP BY thread_id
      ),
      live_sessions AS (
        SELECT bindings.thread_id, sessions.provider_instance_id
        FROM orchestration_v2_projection_provider_sessions AS sessions
        JOIN orchestration_v2_projection_provider_session_bindings AS bindings
          ON bindings.provider_session_id = sessions.provider_session_id
        WHERE sessions.status NOT IN ('stopped', 'error')
      )
      SELECT
        threads.thread_id AS "threadId",
        threads.title AS title,
        runs.thread_id IS NOT NULL AS working,
        COALESCE(runs.provider_instance_id, MIN(sessions.provider_instance_id)) AS "providerInstanceId"
      FROM orchestration_v2_projection_threads AS threads
      LEFT JOIN working_runs AS runs ON runs.thread_id = threads.thread_id
      LEFT JOIN live_sessions AS sessions ON sessions.thread_id = threads.thread_id
      WHERE threads.deleted_at IS NULL
        AND (runs.thread_id IS NOT NULL OR sessions.thread_id IS NOT NULL)
      GROUP BY threads.thread_id
      ORDER BY runs.thread_id IS NULL, threads.updated_at DESC
    `,
  });

  const readPressure = Effect.fn("MachineStatusReader.readPressure")(function* () {
    const [cpu, memory, io] = yield* Effect.forEach(["cpu", "memory", "io"], (kind) =>
      Effect.map(readFile(`/proc/pressure/${kind}`), parsePressure),
    );
    return cpu && memory && io ? { cpu, memory, io } : null;
  });

  const readDisk = Effect.promise(() =>
    NodeFSP.statfs(config.baseDir, { bigint: true }).then(
      (stats) => ({
        totalBytes: Number(stats.blocks * stats.bsize),
        freeBytes: Number(stats.bavail * stats.bsize),
      }),
      () => null,
    ),
  );

  const sample = Effect.fn("MachineStatusReader.sample")(function* () {
    const [host, rows, disk, current] = yield* Effect.all(
      [
        hostResources.read,
        readAgents(undefined).pipe(Effect.orDie),
        readDisk,
        settings.getSettings.pipe(Effect.orElseSucceed(() => null)),
      ],
      { concurrency: "unbounded" },
    );
    // /proc/meminfo is the host's view; HostResources narrows to the server's own cgroup.
    const meminfo = platform === "linux" ? parseMeminfo(yield* readFile("/proc/meminfo")) : null;
    const working = rows.filter((row) => row.working !== 0).length;
    const agents = rows.slice(0, MAX_LISTED_AGENTS).map((row): MachineAgent => ({
      threadId: row.threadId,
      title: row.title,
      state: row.working !== 0 ? "working" : "open",
      providerInstanceId: isProviderInstanceId(row.providerInstanceId)
        ? row.providerInstanceId
        : null,
    }));
    const [one = 0, five = 0, fifteen = 0] = NodeOS.loadavg();
    return {
      hostname: NodeOS.hostname().trim() || "localhost",
      platform,
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cores: Math.max(1, NodeOS.cpus().length),
      load: platform === "win32" ? null : ([one, five, fifteen] as const),
      cpuUtilization: host.cpuUtilization,
      memory: meminfo?.memory ?? {
        totalBytes: host.totalMemoryBytes,
        availableBytes: host.availableMemoryBytes,
      },
      swap: meminfo?.swap ?? null,
      disk,
      pressure: platform === "linux" ? yield* readPressure() : null,
      working,
      open: rows.length - working,
      maxWorkingAgents: current?.machineStatus.maxWorkingAgents ?? null,
      agents,
    } satisfies MachineStatus;
  });

  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "machine") => sample(),
    timeToLive: "5 seconds",
  });
  return MachineStatusReader.of({ read: Cache.get(cache, "machine") });
});

export const layer = Layer.effect(MachineStatusReader, make);
