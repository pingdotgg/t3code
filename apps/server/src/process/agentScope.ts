// @effect-diagnostics nodeBuiltinImport:off -- unit names and RAM size come from the host.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  AgentScope,
  agentScopeCommand,
  type AgentScopeShape,
  type AgentSystemdScope,
} from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";

/**
 * Agents and terminals share this slice. It sits in app.slice next to the
 * server's own unit, so the server's CPUWeight and IOWeight compete with the
 * agents directly.
 */
const AGENT_SLICE = "app-t3code-agents.slice";

const GiB = 1024 ** 3;

/**
 * Memory limits for the agents slice. Agents together leave about 6 GB free
 * before they are throttled and 4 GB before the kernel kills one, so the
 * server, sshd, and tailscaled keep working. Small machines still give agents
 * at least half of RAM before throttling and three quarters before a kill.
 */
export function agentSliceMemoryLimits(totalBytes: number) {
  return {
    high: Math.max(totalBytes - 6 * GiB, Math.floor(totalBytes / 2)),
    max: Math.max(totalBytes - 4 * GiB, Math.floor(totalBytes * 0.75)),
  };
}

export interface ScopeState {
  readonly loadState: string;
  readonly activeState: string;
  readonly result: string;
  /** `oom_kill` from the scope's memory.events, while its cgroup exists. */
  readonly oomKills: number;
  /** `populated` from the scope's cgroup.events, while its cgroup exists. */
  readonly populated: boolean | undefined;
}

/**
 * Reads one scope as the server sees it right after the agent process exits.
 * Our pipe can close before systemd handles the kill, so a scope that is
 * still stopping, is empty, or already counted an OOM kill is "stopping":
 * systemd records `Result=oom-kill` for it in a moment.
 */
export function classifyScope(state: ScopeState): "oom-killed" | "gone" | "running" | "stopping" {
  if (state.result === "oom-kill") return "oom-killed";
  if (
    state.loadState !== "loaded" ||
    state.activeState === "inactive" ||
    state.activeState === "failed"
  ) {
    return "gone";
  }
  if (state.activeState === "deactivating" || state.oomKills > 0 || state.populated === false) {
    return "stopping";
  }
  return "running";
}

function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  return values;
}

function parseCgroupCounter(text: string, key: string): number | undefined {
  const match = new RegExp(`^${key} (\\d+)$`, "m").exec(text);
  return match === null ? undefined : Number(match[1]);
}

const STOPPING_POLL_INTERVAL = "100 millis";
const STOPPING_POLL_ATTEMPTS = 20;
// A stopping scope can wait out TimeoutStopSec (90 s by default) for a stuck process.
const CLEAR_FAILED_INTERVAL = "1 second";
const CLEAR_FAILED_ATTEMPTS = 120;
const MAX_UNITS_PER_THREAD = 2;

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux") return AgentScope.defaultValue();

  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcess.Environment;
  const layerScope = yield* Effect.scope;

  const resolve = (command: string, env: NodeJS.ProcessEnv) =>
    resolveCommandPath(command, { env }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.option,
    );

  const run = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: "5 seconds" }).pipe(Effect.option);

  // Runs once, on the first agent launch. It proves this process can reach a
  // systemd user manager, creates the agents slice, and sets its limits.
  const systemd = yield* Effect.cached(
    Effect.gen(function* () {
      const runtimeDir = hostEnvironment.XDG_RUNTIME_DIR;
      if (runtimeDir === undefined || runtimeDir.length === 0) return undefined;
      const systemdRun = yield* resolve("systemd-run", hostEnvironment);
      const systemctl = yield* resolve("systemctl", hostEnvironment);
      if (systemdRun._tag === "None" || systemctl._tag === "None") return undefined;
      const probe = yield* run(systemdRun.value, [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        `--slice=${AGENT_SLICE}`,
        "--",
        "true",
      ]);
      if (probe._tag === "None" || probe.value.code !== 0) {
        yield* Effect.logInfo("Agent scopes are off: no systemd user manager", {
          stderr: probe._tag === "Some" ? probe.value.stderr.trim() : undefined,
        });
        return undefined;
      }
      const limits = agentSliceMemoryLimits(NodeOS.totalmem());
      const limited = yield* run(systemctl.value, [
        "--user",
        "set-property",
        "--runtime",
        AGENT_SLICE,
        `MemoryHigh=${limits.high}`,
        `MemoryMax=${limits.max}`,
      ]);
      if (limited._tag === "None" || limited.value.code !== 0) {
        yield* Effect.logWarning("Could not set memory limits on the agents slice", {
          stderr: limited._tag === "Some" ? limited.value.stderr.trim() : undefined,
        });
      }
      yield* Effect.logInfo("Agent scopes are on", { slice: AGENT_SLICE, ...limits });
      return { systemdRun: systemdRun.value, systemctl: systemctl.value, runtimeDir };
    }),
  );

  // Recent scope units per thread. A thread runs one agent at a time, plus a
  // replacement during a restart, so older units have ended.
  const unitsByThread = new Map<string, Set<string>>();
  // Threads whose latest agent was OOM-killed, until they launch another.
  const oomKilledThreads = new Set<string>();

  const readCgroupFile = (controlGroup: string, file: string) =>
    fileSystem
      .readFileString(path.join("/sys/fs/cgroup", controlGroup, file))
      .pipe(Effect.orElseSucceed(() => ""));

  const readScope = (systemctl: string, unit: string) =>
    Effect.gen(function* () {
      const shown = yield* run(systemctl, [
        "--user",
        "show",
        unit,
        "--property=LoadState,ActiveState,Result,ControlGroup",
      ]);
      // A failed query says nothing about the scope; the caller keeps the unit.
      if (shown._tag === "None" || shown.value.code !== 0) return undefined;
      const values = parseKeyValues(shown.value.stdout);
      const controlGroup = values.get("ControlGroup") ?? "";
      const memoryEvents = controlGroup ? yield* readCgroupFile(controlGroup, "memory.events") : "";
      const cgroupEvents = controlGroup ? yield* readCgroupFile(controlGroup, "cgroup.events") : "";
      const populated = parseCgroupCounter(cgroupEvents, "populated");
      return {
        loadState: values.get("LoadState") ?? "",
        activeState: values.get("ActiveState") ?? "",
        result: values.get("Result") ?? "",
        oomKills: parseCgroupCounter(memoryEvents, "oom_kill") ?? 0,
        populated: populated === undefined ? undefined : populated === 1,
      } satisfies ScopeState;
    });

  const clearFailed = (systemctl: string, unit: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < CLEAR_FAILED_ATTEMPTS; attempt++) {
        const state = yield* readScope(systemctl, unit);
        if (state === undefined) return;
        if (state.activeState === "failed") {
          yield* run(systemctl, ["--user", "reset-failed", unit]);
          return;
        }
        if (state.activeState !== "deactivating") return;
        yield* Effect.sleep(CLEAR_FAILED_INTERVAL);
      }
    });

  const oomKilled: AgentScopeShape["oomKilled"] = (threadId) =>
    Effect.gen(function* () {
      if (oomKilledThreads.has(threadId)) return true;
      const units = unitsByThread.get(threadId);
      if (units === undefined) return false;
      const scope = yield* systemd;
      if (scope === undefined) return false;
      for (let attempt = 0; attempt < STOPPING_POLL_ATTEMPTS; attempt++) {
        let stopping = false;
        for (const unit of units) {
          const state = yield* readScope(scope.systemctl, unit);
          if (state === undefined) continue;
          const status = classifyScope(state);
          if (status === "running") continue;
          if (status === "stopping") {
            stopping = true;
            continue;
          }
          units.delete(unit);
          // Failed scopes stay loaded so we can read their result. Clear them
          // once systemd finishes stopping them.
          if (state.activeState === "failed" || state.activeState === "deactivating") {
            yield* clearFailed(scope.systemctl, unit).pipe(Effect.forkIn(layerScope));
          }
          if (status === "oom-killed") {
            yield* Effect.logWarning("Agent scope was killed: out of memory", { threadId, unit });
            oomKilledThreads.add(threadId);
            return true;
          }
        }
        if (units.size === 0) unitsByThread.delete(threadId);
        if (!stopping) return false;
        yield* Effect.sleep(STOPPING_POLL_INTERVAL);
      }
      return false;
    });

  return {
    wrap: Effect.fn("AgentScope.wrap")(function* ({ command, args, name, threadId, env }) {
      const resolved = yield* resolve(command, env ?? hostEnvironment);
      // Leave unresolved commands alone so the spawn reports the missing binary.
      if (resolved._tag === "None") return { command, args };
      const scope = yield* systemd;
      if (scope === undefined) return agentScopeCommand({ command: resolved.value, args });
      const unit = `t3code-${name}-${NodeCrypto.randomUUID().slice(0, 8)}.scope`;
      if (threadId !== undefined) {
        oomKilledThreads.delete(threadId);
        const units = unitsByThread.get(threadId) ?? new Set<string>();
        units.add(unit);
        // Sets keep insertion order, so the first unit is the oldest.
        for (const old of units) {
          if (units.size <= MAX_UNITS_PER_THREAD) break;
          units.delete(old);
        }
        unitsByThread.set(threadId, units);
      }
      const systemdScope: AgentSystemdScope = {
        systemdRun: scope.systemdRun,
        runtimeDir: scope.runtimeDir,
        slice: AGENT_SLICE,
        unit,
      };
      return agentScopeCommand({ command: resolved.value, args, scope: systemdScope });
    }),
    oomKilled,
  } satisfies AgentScopeShape;
});

export const layer = Layer.effect(AgentScope, make).pipe(Layer.provide(ProcessRunner.layer));
