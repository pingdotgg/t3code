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

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const AGENT_SLICE = "app-t3code-agents.slice";

export function ownedAgentSlice(stateDir: string): string {
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  return `app-t3code-agents-${hash}.slice`;
}

const GiB = 1024 ** 3;

/**
 * Agents together leave about 6 GB free before they are throttled and 4 GB
 * before the kernel kills one, so the server, sshd, and tailscaled keep
 * working. Small machines still give agents at least half of RAM before
 * throttling and three quarters before a kill.
 */
function agentSliceMemoryLimits(totalBytes: number) {
  return {
    high: Math.max(totalBytes - 6 * GiB, Math.floor(totalBytes / 2)),
    max: Math.max(totalBytes - 4 * GiB, Math.floor(totalBytes * 0.75)),
  };
}

export interface ScopeState {
  readonly loadState: string;
  readonly activeState: string;
  readonly result: string;
  readonly oomKills: number | undefined;
  readonly populated: boolean | undefined;
}

/** Pipes can close before systemd records oom-kill; stopping, empty or OOM-counted scopes remain pending. */
export function classifyScope(state: ScopeState): "oom-killed" | "gone" | "running" | "stopping" {
  if (state.result === "oom-kill") return "oom-killed";
  if (
    state.loadState !== "loaded" ||
    state.activeState === "inactive" ||
    state.activeState === "failed"
  ) {
    return "gone";
  }
  if (
    state.activeState === "deactivating" ||
    (state.oomKills ?? 0) > 0 ||
    state.populated === false
  ) {
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

// systemd's default 90 s stop timeout would outlast our leftover-agent wait.
// Delegation lets rootless containers (Podman, kind) manage their own cgroups.
const SCOPE_OPTIONS = ["--property=TimeoutStopSec=10s", "--property=Delegate=yes"];
const STOPPING_POLL_INTERVAL = "100 millis";
const STOPPING_POLL_ATTEMPTS = 20;
const CLEAR_FAILED_INTERVAL = "1 second";
const CLEAR_FAILED_ATTEMPTS = 120;
const MAX_TRACKED_THREADS = 500;

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux") return AgentScope.defaultValue();

  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcess.Environment;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const ownedSlice = ownedAgentSlice(stateDir);
  const layerScope = yield* Effect.scope;

  const resolve = (command: string, env: NodeJS.ProcessEnv) =>
    resolveCommandPath(command, { env }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
    );

  const run = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: "5 seconds" }).pipe(Effect.option);

  const readCgroupFile = (controlGroup: string, file: string) =>
    fileSystem
      .readFileString(path.join("/sys/fs/cgroup", controlGroup, file))
      .pipe(Effect.orElseSucceed(() => ""));

  // Old agents keep their scopes when the server is killed, and the restarted
  // server resumes their sessions. Stop them first, so two copies of one
  // session never work in the same worktree.
  const stopLeftoverAgents = Effect.fn("agentScope.stopLeftoverAgents")(function* (
    systemctl: string,
  ) {
    const shown = yield* run(systemctl, [
      "--user",
      "show",
      ownedSlice,
      "--property=ActiveState,ControlGroup",
    ]);
    if (shown._tag === "None") return;
    const values = parseKeyValues(shown.value.stdout);
    if (values.get("ActiveState") !== "active") return;
    const controlGroup = values.get("ControlGroup") ?? "";
    const events = controlGroup ? yield* readCgroupFile(controlGroup, "cgroup.events") : "";
    if (parseCgroupCounter(events, "populated") === 0) return;
    yield* Effect.logWarning("Stopping agents left by a previous server", { slice: ownedSlice });
    const stopped = yield* runner
      .run({ command: systemctl, args: ["--user", "stop", ownedSlice], timeout: "30 seconds" })
      .pipe(Effect.option);
    if (stopped._tag === "None" || stopped.value.code !== 0) {
      yield* Effect.logWarning("Could not stop agents left by a previous server", {
        slice: ownedSlice,
        stderr: stopped._tag === "Some" ? stopped.value.stderr.trim() : undefined,
      });
    }
  });

  const systemd = yield* Effect.cached(
    Effect.gen(function* () {
      const runtimeDir = hostEnvironment.XDG_RUNTIME_DIR;
      if (runtimeDir === undefined || runtimeDir.length === 0) return undefined;
      const systemdRun = yield* resolve("systemd-run", hostEnvironment);
      const systemctl = yield* resolve("systemctl", hostEnvironment);
      if (systemdRun === null || systemctl === null) return undefined;
      yield* stopLeftoverAgents(systemctl);
      const probe = (options: ReadonlyArray<string>) =>
        run(systemdRun, [
          "--user",
          "--scope",
          "--quiet",
          "--collect",
          `--slice=${AGENT_SLICE}`,
          ...options,
          "--",
          "true",
        ]).pipe(Effect.map((result) => result._tag === "Some" && result.value.code === 0));
      // Scopes take OOMPolicy from systemd 253; older managers still get scopes.
      const supportsOomPolicy = yield* probe([...SCOPE_OPTIONS, "--property=OOMPolicy=stop"]);
      if (!supportsOomPolicy && !(yield* probe(SCOPE_OPTIONS))) {
        yield* Effect.logInfo("Agent scopes are off: no systemd user manager");
        return undefined;
      }
      const limits = agentSliceMemoryLimits(NodeOS.totalmem());
      const limited = yield* run(systemctl, [
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
      yield* Effect.logInfo("Agent scopes are on", {
        slice: AGENT_SLICE,
        ...limits,
        oomPolicy: supportsOomPolicy,
      });
      return {
        systemdRun,
        systemctl,
        runtimeDir,
        supportsOomPolicy,
      };
    }),
  );

  const scopeByThread = new Map<string, { unit: string; oomKilled: boolean }>();

  const readScope = Effect.fn("agentScope.readScope")(function* (systemctl: string, unit: string) {
    const shown = yield* run(systemctl, [
      "--user",
      "show",
      unit,
      "--property=LoadState,ActiveState,Result,ControlGroup",
    ]);
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
      oomKills: parseCgroupCounter(memoryEvents, "oom_kill"),
      populated: populated === undefined ? undefined : populated === 1,
    } satisfies ScopeState;
  });

  const clearFailed = Effect.fn("agentScope.clearFailed")(function* (
    systemctl: string,
    unit: string,
  ) {
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

  const forget = (systemctl: string, unit: string) =>
    clearFailed(systemctl, unit).pipe(Effect.forkIn(layerScope), Effect.asVoid);

  const evictOldest = Effect.fn("agentScope.evictOldest")(function* (systemctl: string) {
    const oldest = scopeByThread.entries().next();
    if (oldest.done === true) return;
    const [threadId, tracked] = oldest.value;
    const state = yield* readScope(systemctl, tracked.unit);
    if (scopeByThread.get(threadId) !== tracked) return;
    scopeByThread.delete(threadId);
    const status = state === undefined ? "running" : classifyScope(state);
    if (status === "running" || status === "stopping") {
      scopeByThread.set(threadId, tracked);
      return;
    }
    yield* forget(systemctl, tracked.unit);
  });

  const track = Effect.fn("agentScope.track")(function* (
    systemctl: string,
    threadId: string,
    unit: string | undefined,
  ) {
    const previous = scopeByThread.get(threadId);
    scopeByThread.delete(threadId);
    if (unit !== undefined) scopeByThread.set(threadId, { unit, oomKilled: false });
    if (previous !== undefined) yield* forget(systemctl, previous.unit);
    if (scopeByThread.size > MAX_TRACKED_THREADS) yield* evictOldest(systemctl);
  });

  const oomKilled: AgentScopeShape["oomKilled"] = Effect.fn("agentScope.oomKilled")(
    function* (threadId) {
      const tracked = scopeByThread.get(threadId);
      if (tracked === undefined) return false;
      if (tracked.oomKilled) return true;
      const scope = yield* systemd;
      if (scope === undefined) return false;
      for (let attempt = 0; attempt < STOPPING_POLL_ATTEMPTS; attempt++) {
        const state = yield* readScope(scope.systemctl, tracked.unit);
        if (state === undefined) return false;
        const status = classifyScope(state);
        if (status === "running") return false;
        if (status === "stopping") {
          yield* Effect.sleep(STOPPING_POLL_INTERVAL);
          continue;
        }
        yield* forget(scope.systemctl, tracked.unit);
        if (status === "gone") return false;
        yield* Effect.logWarning("Agent scope was killed: out of memory", {
          threadId,
          unit: tracked.unit,
        });
        tracked.oomKilled = true;
        return true;
      }
      return false;
    },
  );

  const stop = Effect.fn("AgentScope.stop")(function* (unit: string) {
    if (!unit.startsWith("t3code-") || !unit.endsWith(".scope")) return;
    const scope = yield* systemd;
    if (scope === undefined) return;
    const state = yield* readScope(scope.systemctl, unit);
    if (
      state === undefined ||
      state.loadState !== "loaded" ||
      state.activeState !== "active" ||
      state.result === "oom-kill" ||
      state.populated === false
    )
      return;
    // The kernel counts OOM kills before signaling the victim. Let OOMPolicy
    // record the result before a manual stop can overwrite it; an unreadable
    // counter cannot rule out that race. Older managers need us to stop it.
    if (scope.supportsOomPolicy && (state.oomKills === undefined || state.oomKills > 0)) return;
    const stopped = yield* run(scope.systemctl, ["--user", "stop", "--no-block", unit]);
    if (stopped._tag === "None" || stopped.value.code !== 0) {
      yield* Effect.logWarning("Could not stop an exited agent's scope", {
        unit,
        exitCode: stopped._tag === "Some" ? stopped.value.code : undefined,
      });
    }
  });

  const clear: AgentScopeShape["clear"] = Effect.fn("agentScope.clear")(function* (threadId) {
    if (!scopeByThread.has(threadId)) return;
    const scope = yield* systemd;
    if (scope !== undefined) yield* track(scope.systemctl, threadId, undefined);
  });

  return {
    wrap: Effect.fn("AgentScope.wrap")(function* ({
      command,
      args,
      name,
      threadId,
      env,
      survivesRestart,
      shared,
    }) {
      const resolved = yield* resolve(command, env ?? hostEnvironment);
      if (resolved === null) return { command, args };
      const scope = yield* systemd;
      if (scope === undefined) return agentScopeCommand({ command: resolved, args });
      const unit = `t3code-${name}-${NodeCrypto.randomUUID().slice(0, 8)}.scope`;
      // A continuing shared scope cannot attribute a tool's OOM to one thread.
      // Clear the launch thread's previous scope instead.
      const continuing = shared === true && scope.supportsOomPolicy;
      const owned = threadId !== undefined && !continuing;
      if (threadId !== undefined) yield* track(scope.systemctl, threadId, owned ? unit : undefined);
      const systemdScope: AgentSystemdScope = {
        systemdRun: scope.systemdRun,
        runtimeDir: scope.runtimeDir,
        slice: survivesRestart === true ? AGENT_SLICE : ownedSlice,
        unit,
        // Without an owning thread nothing reads the result, so let systemd
        // unload the unit even when it fails.
        options: [
          ...SCOPE_OPTIONS,
          ...(scope.supportsOomPolicy
            ? [`--property=OOMPolicy=${continuing ? "continue" : "stop"}`]
            : []),
          ...(owned ? [] : ["--collect"]),
        ],
      };
      return { ...agentScopeCommand({ command: resolved, args, scope: systemdScope }), unit };
    }),
    oomKilled,
    stop,
    clear,
  } satisfies AgentScopeShape;
});

export const layer = Layer.effect(AgentScope, make).pipe(Layer.provide(ProcessRunner.layer));
