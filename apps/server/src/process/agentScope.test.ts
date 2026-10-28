// @effect-diagnostics nodeBuiltinImport:off -- fake systemd binaries live in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import { makeCodexAppServerSpawnCommand } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProcessRunner from "../processRunner.ts";
import { classifyScope, make, ownedAgentSlice, type ScopeState } from "./agentScope.ts";

const running: ScopeState = {
  loadState: "loaded",
  activeState: "active",
  result: "success",
  oomKills: 0,
  populated: true,
};

describe("classifyScope", () => {
  it("reports an OOM kill only once systemd records it", () => {
    expect(classifyScope({ ...running, activeState: "failed", result: "oom-kill" })).toBe(
      "oom-killed",
    );
    expect(classifyScope({ ...running, oomKills: 1 })).toBe("stopping");
    expect(classifyScope({ ...running, populated: false })).toBe("stopping");
    expect(classifyScope({ ...running, activeState: "deactivating" })).toBe("stopping");
  });
});

interface FakeUnit {
  activeState: string;
  result: string;
  controlGroup?: string;
}

const withFakeSystemd = <A, E>(
  body: (input: {
    readonly scope: Effect.Success<typeof make>;
    readonly units: Map<string, FakeUnit>;
    readonly calls: ReadonlyArray<ReadonlyArray<string>>;
    readonly stateDir: string;
    readonly cgroupRoot: string;
  }) => Effect.Effect<A, E>,
  // A user manager older than systemd 253 rejects OOMPolicy on scopes.
  {
    oomPolicy = true,
    stopFails = false,
  }: { readonly oomPolicy?: boolean; readonly stopFails?: boolean } = {},
) =>
  Effect.gen(function* () {
    const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-scope-"));
    for (const name of ["systemd-run", "systemctl", "agent"]) {
      NodeFS.writeFileSync(NodePath.join(bin, name), "", { mode: 0o755 });
    }
    const cgroupRoot = NodePath.join(bin, "cgroup");
    const units = new Map<string, FakeUnit>();
    const calls: Array<ReadonlyArray<string>> = [];
    const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
      stdout,
      stderr: "",
      code: ChildProcessSpawner.ExitCode(code),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
    const runner = ProcessRunner.ProcessRunner.of({
      run: ({ args }) =>
        Effect.sync(() => {
          calls.push(args);
          if (!oomPolicy && args.some((arg) => arg.startsWith("--property=OOMPolicy="))) {
            return output("", 1);
          }
          const [, verb, unit = ""] = args;
          if (stopFails && verb === "stop") {
            return {
              ...output(""),
              stderr: `Failed to stop ${args.at(-1)}: Unit not loaded.`,
              code: ChildProcessSpawner.ExitCode(5),
            };
          }
          if (verb === "reset-failed") units.delete(unit);
          if (verb !== "show") return output("");
          const state = units.get(unit);
          return output(
            state === undefined
              ? "LoadState=not-found\nActiveState=inactive\nResult=success\n"
              : `LoadState=loaded\nActiveState=${state.activeState}\nResult=${state.result}\n` +
                  `ControlGroup=${state.controlGroup ?? ""}\n`,
          );
        }),
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const scope = yield* make.pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: bin, XDG_RUNTIME_DIR: "/run/user/1" }),
      Effect.provideService(FileSystem.FileSystem, {
        ...fileSystem,
        readFileString: (path, encoding) =>
          fileSystem.readFileString(path.replace("/sys/fs/cgroup", cgroupRoot), encoding),
      }),
    );
    const { stateDir } = yield* ServerConfig.ServerConfig;
    return yield* body({ scope, units, calls, stateDir, cgroupRoot }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(bin, { recursive: true, force: true }))),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-scope-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const unitOf = (launch: { readonly args: ReadonlyArray<string> }) =>
  launch.args.find((arg) => arg.startsWith("--unit="))?.slice("--unit=".length) ?? "";

const sliceOf = (launch: { readonly args: ReadonlyArray<string> }) =>
  launch.args.find((arg) => arg.startsWith("--slice="))?.slice("--slice=".length) ?? "";

/** An active scope as systemd and the kernel report it, with the agent itself gone. */
const exitedAgent = (
  units: Map<string, FakeUnit>,
  cgroupRoot: string,
  unit: string,
  { populated, oomKills }: { readonly populated: boolean; readonly oomKills: number | undefined },
) => {
  const controlGroup = `/${unit}`;
  NodeFS.mkdirSync(NodePath.join(cgroupRoot, controlGroup), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(cgroupRoot, controlGroup, "cgroup.events"),
    `populated ${populated ? 1 : 0}\nfrozen 0\n`,
  );
  // An undefined count leaves memory.events unreadable.
  if (oomKills !== undefined) {
    NodeFS.writeFileSync(
      NodePath.join(cgroupRoot, controlGroup, "memory.events"),
      `low 0\nhigh 0\nmax 0\noom ${oomKills}\noom_kill ${oomKills}\noom_group_kill 0\n`,
    );
  }
  units.set(unit, { activeState: "active", result: "success", controlGroup });
};

const stopsOf = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter(([, verb]) => verb === "stop");
const launchCodex = (scope: Effect.Success<typeof make>, threadId: string) =>
  makeCodexAppServerSpawnCommand({ command: "agent", args: ["app-server"], threadId }).pipe(
    Effect.provideService(AgentScope, scope),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.map((command) => {
      assert(ChildProcess.isStandardCommand(command));
      return command;
    }),
  );

describe("AgentScope service", () => {
  it.effect("labels a thread from its newest scope until its next session clears it", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const first = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(first), { activeState: "failed", result: "oom-kill" });
        const second = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(second), { activeState: "active", result: "success" });
        expect(yield* scope.oomKilled("a")).toBe(false);

        units.set(unitOf(second), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("a")).toBe(true);
        units.delete(unitOf(second));
        expect(yield* scope.oomKilled("a")).toBe(true);

        yield* scope.clear("a");
        expect(yield* scope.oomKilled("a")).toBe(false);
      }),
    ),
  );

  it.effect(
    "keeps shared Codex scopes running without attributing their OOM to the launch thread",
    () =>
      withFakeSystemd(({ scope, units, calls }) =>
        Effect.gen(function* () {
          const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
          expect(agent.args).toContain("--property=OOMPolicy=stop");
          units.set(unitOf(agent), { activeState: "failed", result: "oom-kill" });
          expect(yield* scope.oomKilled("a")).toBe(true);

          const codex = yield* launchCodex(scope, "a");
          expect(codex.args).toContain("--property=OOMPolicy=continue");
          expect(codex.args).not.toContain("--property=OOMPolicy=stop");
          expect(codex.args).toContain("--property=TimeoutStopSec=10s");
          expect(codex.args).toContain("--collect");
          units.set(unitOf(codex), { activeState: "active", result: "success" });
          expect(yield* scope.oomKilled("a")).toBe(false);
          units.set(unitOf(codex), { activeState: "failed", result: "oom-kill" });
          expect(yield* scope.oomKilled("a")).toBe(false);
          expect(
            calls.filter(([, verb, unit]) => verb === "show" && unit === unitOf(codex)),
          ).toEqual([]);
        }),
      ),
  );

  it.effect("keeps a running scope while hundreds of other threads launch", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const live = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "live" });
        units.set(unitOf(live), { activeState: "active", result: "success" });
        for (let index = 0; index < 600; index++) {
          yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: `other-${index}` });
        }
        units.set(unitOf(live), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("live")).toBe(true);
      }),
    ),
  );

  it.effect("delegates every agent scope so rootless containers can manage their cgroups", () =>
    withFakeSystemd(({ scope }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const codex = yield* launchCodex(scope, "a");
        const terminal = yield* scope.wrap({
          command: "agent",
          args: [],
          name: "terminal",
          survivesRestart: true,
        });
        for (const launch of [agent, codex, terminal]) {
          expect(launch.args).toContain("--property=Delegate=yes");
        }
      }),
    ),
  );

  it.effect("stops agents a killed server left before the first launch", () =>
    withFakeSystemd(({ scope, units, calls, stateDir }) =>
      Effect.gen(function* () {
        units.set(ownedAgentSlice(stateDir), { activeState: "active", result: "success" });
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const stops = calls.filter(([, verb]) => verb === "stop");
        expect(stops).toEqual([["--user", "stop", ownedAgentSlice(stateDir)]]);
        expect(sliceOf(agent)).toBe(ownedAgentSlice(stateDir));
        expect(agent.args).toContain("--property=TimeoutStopSec=10s");
        const terminal = yield* scope.wrap({
          command: "agent",
          args: [],
          name: "terminal",
          survivesRestart: true,
        });
        expect(sliceOf(terminal)).toBe("app-t3code-agents.slice");
        expect(calls.filter(([, verb]) => verb === "stop")).toHaveLength(1);
      }),
    ),
  );

  it.effect("stops leftover processes only in an active agent scope", () =>
    withFakeSystemd(({ scope, units, calls, cgroupRoot }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const unit = unitOf(agent);
        expect(agent.unit).toBe(unit);

        yield* scope.stop("session-2.scope");
        expect(calls.some((args) => args.includes("session-2.scope"))).toBe(false);
        yield* scope.stop(unit);
        exitedAgent(units, cgroupRoot, unit, { populated: false, oomKills: 0 });
        yield* scope.stop(unit);
        exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: 0 });
        units.get(unit)!.activeState = "deactivating";
        yield* scope.stop(unit);
        expect(stopsOf(calls)).toEqual([]);

        units.get(unit)!.activeState = "active";
        yield* scope.stop(unit);
        expect(stopsOf(calls)).toEqual([["--user", "stop", "--no-block", unit]]);
        expect(yield* scope.oomKilled("a")).toBe(false);
      }),
    ),
  );

  it.effect.each([true, false])(
    "cleans up an OOM exit without losing its diagnosis (OOMPolicy=%s)",
    (oomPolicy) =>
      withFakeSystemd(
        ({ scope, units, calls, cgroupRoot }) =>
          Effect.gen(function* () {
            const agent = yield* scope.wrap({
              command: "agent",
              args: [],
              name: "t",
              threadId: "a",
            });
            const unit = unitOf(agent);
            exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: undefined });
            yield* scope.stop(unit);
            expect(stopsOf(calls)).toEqual(
              oomPolicy ? [] : [["--user", "stop", "--no-block", unit]],
            );

            // The kernel records the kill before systemd records the OOM result.
            exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: 1 });
            yield* scope.stop(unit);
            expect(stopsOf(calls)).toHaveLength(oomPolicy ? 0 : 2);

            if (oomPolicy) {
              units.set(unit, { activeState: "failed", result: "oom-kill" });
              expect(yield* scope.oomKilled("a")).toBe(true);
              units.delete(unit);
              expect(yield* scope.oomKilled("a")).toBe(true);
            }
          }),
        { oomPolicy },
      ),
  );

  it.effect("reports failed daemon cleanup without failing session teardown", () => {
    const warnings: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      warnings.push(message);
    });
    return withFakeSystemd(
      ({ scope, units, cgroupRoot }) =>
        Effect.gen(function* () {
          const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
          exitedAgent(units, cgroupRoot, unitOf(agent), { populated: true, oomKills: 0 });
          yield* scope.stop(unitOf(agent));
          expect(warnings.flat()).toContain("Could not stop an exited agent's scope");
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
      { stopFails: true },
    );
  });

  it.effect("leaves a quiet slice alone", () =>
    withFakeSystemd(({ scope, calls }) =>
      Effect.gen(function* () {
        yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        expect(calls.filter(([, verb]) => verb === "stop")).toEqual([]);
      }),
    ),
  );
});
