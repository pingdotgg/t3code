// @effect-diagnostics nodeBuiltinImport:off -- fake systemd binaries live in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  agentSliceMemoryLimits,
  classifyScope,
  make,
  ownedAgentSlice,
  type ScopeState,
} from "./agentScope.ts";

const GiB = 1024 ** 3;

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

  it("does not wait on a live agent or a scope that ended for another reason", () => {
    expect(classifyScope(running)).toBe("running");
    expect(classifyScope({ ...running, activeState: "inactive", populated: undefined })).toBe(
      "gone",
    );
    expect(classifyScope({ ...running, loadState: "not-found", activeState: "inactive" })).toBe(
      "gone",
    );
  });
});

describe("agentSliceMemoryLimits", () => {
  it("leaves 6 GB before throttling and 4 GB before a kill on large machines", () => {
    expect(agentSliceMemoryLimits(64 * GiB)).toEqual({ high: 58 * GiB, max: 60 * GiB });
  });

  it("still gives agents most of a small machine", () => {
    expect(agentSliceMemoryLimits(8 * GiB)).toEqual({ high: 4 * GiB, max: 6 * GiB });
  });
});

interface FakeScopeState {
  activeState: string;
  result: string;
  oomKills?: number | undefined;
  populated?: boolean;
}

const withFakeSystemd = <A, E>(
  body: (input: {
    readonly scope: Effect.Success<typeof make>;
    readonly units: Map<string, FakeScopeState>;
    readonly calls: ReadonlyArray<ReadonlyArray<string>>;
    readonly stateDir: string;
    readonly handlers: Map<
      string,
      (
        input: ProcessRunner.ProcessRunInput,
      ) => Effect.Effect<ProcessRunner.ProcessRunOutput | undefined>
    >;
    readonly output: (stdout: string) => ProcessRunner.ProcessRunOutput;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-scope-"));
    for (const name of ["systemd-run", "systemctl", "agent"]) {
      NodeFS.writeFileSync(NodePath.join(bin, name), "", { mode: 0o755 });
    }
    const units = new Map<string, FakeScopeState>();
    const calls: Array<ReadonlyArray<string>> = [];
    const handlers = new Map<
      string,
      (
        input: ProcessRunner.ProcessRunInput,
      ) => Effect.Effect<ProcessRunner.ProcessRunOutput | undefined>
    >();
    const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
      stdout,
      stderr: "",
      code: ChildProcessSpawner.ExitCode(0),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.gen(function* () {
          const { args } = input;
          calls.push(args);
          const [, verb = "", unit = ""] = args;
          const handled = yield* handlers.get(verb)?.(input) ?? Effect.succeed(undefined);
          if (handled !== undefined) return handled;
          if (verb === "stop") units.delete(unit);
          if (verb === "reset-failed") units.delete(unit);
          if (verb !== "show") return output("");
          const state = units.get(unit);
          return output(
            state === undefined
              ? "LoadState=not-found\nActiveState=inactive\nResult=success\n"
              : `LoadState=loaded\nActiveState=${state.activeState}\nResult=${state.result}\nControlGroup=/t3-agent-scope-test/${unit}\n`,
          );
        }),
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const scope = yield* make.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fileSystem,
        readFileString: (path, encoding) => {
          if (!path.startsWith("/sys/fs/cgroup/t3-agent-scope-test/")) {
            return fileSystem.readFileString(path, encoding);
          }
          const state = units.get(NodePath.basename(NodePath.dirname(path)));
          return Effect.succeed(
            path.endsWith("memory.events")
              ? `oom_kill ${state?.oomKills ?? 0}\n`
              : `populated ${state?.populated === false ? 0 : 1}\n`,
          );
        },
      }),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: bin, XDG_RUNTIME_DIR: "/run/user/1" }),
    );
    const { stateDir } = yield* ServerConfig.ServerConfig;
    return yield* body({ scope, units, calls, stateDir, handlers, output }).pipe(
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

describe("AgentScope service", () => {
  it.effect("waits for scope shutdown with a timeout longer than TimeoutStopSec", () =>
    withFakeSystemd(({ scope, units, calls, handlers, output }) =>
      Effect.gen(function* () {
        const launch = yield* scope.wrap({ command: "agent", args: [], name: "acp" });
        const unit = unitOf(launch);
        expect(launch.unit).toBe(unit);
        expect(launch.args).toContain("--property=TimeoutStopSec=10s");
        units.set(unit, { activeState: "active", result: "success", populated: true });
        const stopping = yield* Deferred.make<ProcessRunner.ProcessRunInput>();
        const stopped = yield* Deferred.make<void>();
        handlers.set("stop", (input) =>
          Deferred.succeed(stopping, input).pipe(
            Effect.andThen(Deferred.await(stopped)),
            Effect.andThen(Effect.sync(() => units.delete(unit))),
            Effect.as(output("")),
          ),
        );
        const fiber = yield* scope.stop(unit).pipe(Effect.forkChild);
        expect((yield* Deferred.await(stopping)).timeout).toBe("15 seconds");
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(stopped, undefined);
        yield* Fiber.join(fiber);
        expect(calls.filter(([, verb]) => verb === "stop")).toEqual([["--user", "stop", unit]]);
      }),
    ),
  );

  it.effect.each(["kernel OOM", "OOM result", "deactivating"] as const)(
    "awaits %s shutdown without replacing its diagnosis",
    (pending) =>
      withFakeSystemd(({ scope, units, calls, handlers }) =>
        Effect.gen(function* () {
          const launch = yield* scope.wrap({
            command: "agent",
            args: [],
            name: "acp",
            threadId: "a",
          });
          const unit = unitOf(launch);
          units.set(unit, {
            activeState: pending === "deactivating" ? "deactivating" : "active",
            result: pending === "OOM result" ? "oom-kill" : "success",
            oomKills: pending === "kernel OOM" ? 1 : 0,
            populated: true,
          });
          const waiting = yield* Deferred.make<void>();
          const completed = yield* Deferred.make<void>();
          let reads = 0;
          handlers.set("show", () =>
            ++reads === 2
              ? Deferred.succeed(waiting, undefined).pipe(
                  Effect.andThen(Deferred.await(completed)),
                  Effect.as(undefined),
                )
              : Effect.succeed(undefined),
          );
          const fiber = yield* scope.stop(unit).pipe(Effect.forkChild);
          yield* Deferred.await(waiting);
          expect(fiber.pollUnsafe()).toBeUndefined();
          expect(calls.filter(([, verb]) => verb === "stop")).toEqual([]);
          units.set(unit, { activeState: "failed", result: "oom-kill", populated: false });
          yield* Deferred.succeed(completed, undefined);
          yield* Fiber.join(fiber);
          expect(yield* scope.oomKilled("a")).toBe(true);
          expect(calls.filter(([, verb]) => verb === "stop")).toEqual([]);
        }),
      ),
  );

  it.effect("fails when pending OOM shutdown never finishes", () =>
    withFakeSystemd(({ scope, units, handlers }) =>
      Effect.gen(function* () {
        const launch = yield* scope.wrap({ command: "agent", args: [], name: "acp" });
        const unit = unitOf(launch);
        units.set(unit, { activeState: "active", result: "success", oomKills: 1, populated: true });
        const waiting = yield* Deferred.make<void>();
        let reads = 0;
        handlers.set("show", () =>
          ++reads === 2
            ? Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(undefined),
        );
        const fiber = yield* scope.stop(unit).pipe(Effect.uninterruptible, Effect.forkChild);
        yield* Deferred.await(waiting);
        yield* TestClock.adjust("15 seconds");
        expect(yield* Effect.flip(Fiber.join(fiber))).toMatchObject({
          _tag: "AgentScopeStopError",
          detail: "Agent scope did not finish stopping",
        });
      }),
    ),
  );

  it.effect.each(["failure", "timeout"] as const)("reports a scope stop %s", (failure) =>
    withFakeSystemd(({ scope, units, handlers, output }) =>
      Effect.gen(function* () {
        const launch = yield* scope.wrap({ command: "agent", args: [], name: "acp" });
        const unit = unitOf(launch);
        units.set(unit, { activeState: "active", result: "success", populated: true });
        handlers.set("stop", () =>
          Effect.succeed({
            ...output(""),
            code: ChildProcessSpawner.ExitCode(failure === "failure" ? 1 : 0),
            timedOut: failure === "timeout",
          }),
        );
        expect(yield* Effect.flip(scope.stop(unit))).toMatchObject({
          _tag: "AgentScopeStopError",
          unit,
        });
      }),
    ),
  );

  it.effect("does not report an unreadable scope as stopped", () =>
    withFakeSystemd(({ scope, handlers, output }) =>
      Effect.gen(function* () {
        const launch = yield* scope.wrap({ command: "agent", args: [], name: "acp" });
        handlers.set("show", () =>
          Effect.succeed({ ...output(""), code: ChildProcessSpawner.ExitCode(1) }),
        );
        expect(yield* Effect.flip(scope.stop(unitOf(launch)))).toMatchObject({
          _tag: "AgentScopeStopError",
        });
      }),
    ),
  );

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

  it.effect("leaves a quiet slice alone", () =>
    withFakeSystemd(({ scope, calls }) =>
      Effect.gen(function* () {
        yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        expect(calls.filter(([, verb]) => verb === "stop")).toEqual([]);
      }),
    ),
  );
});
