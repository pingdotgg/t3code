// @effect-diagnostics nodeBuiltinImport:off -- fake systemd binaries live in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { AgentScope, type AgentScopeShape } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { makeCodexAppServerSpawnCommand } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProcessRunner from "../processRunner.ts";
import { agentSliceMemoryLimits, classifyScope, make, type ScopeState } from "./agentScope.ts";

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
    // The agent pipe can close before systemd handles the kill.
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

interface FakeUnit {
  activeState: string;
  result: string;
  /** `oom_kill` in the scope's memory.events. */
  oomKills?: number;
}

// Runs the real service against a fake user manager. `units` holds what
// `systemctl show` and the cgroup files report for each scope. A manager
// without `oomPolicy` (before systemd 253) rejects OOMPolicy on scopes.
const withFakeSystemd = <A, E>(
  body: (input: {
    readonly scope: Effect.Success<typeof make>;
    readonly units: Map<string, FakeUnit>;
  }) => Effect.Effect<A, E>,
  { oomPolicy = true }: { readonly oomPolicy?: boolean } = {},
) =>
  Effect.gen(function* () {
    const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-scope-"));
    for (const name of ["systemd-run", "systemctl", "agent"]) {
      NodeFS.writeFileSync(NodePath.join(bin, name), "", { mode: 0o755 });
    }
    const units = new Map<string, FakeUnit>();
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
          if (!oomPolicy && args.some((arg) => arg.startsWith("--property=OOMPolicy="))) {
            return output("", 1);
          }
          const [, verb, unit = ""] = args;
          if (verb === "reset-failed") units.delete(unit);
          if (verb !== "show") return output("");
          const state = units.get(unit);
          return output(
            state === undefined
              ? "LoadState=not-found\nActiveState=inactive\nResult=success\n"
              : `LoadState=loaded\nActiveState=${state.activeState}\nResult=${state.result}\nControlGroup=/test.slice/${unit}\n`,
          );
        }),
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const scope = yield* make.pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(FileSystem.FileSystem, {
        ...fileSystem,
        readFileString: (file, encoding) =>
          file.startsWith("/sys/fs/cgroup/")
            ? Effect.succeed(
                file.endsWith("/memory.events")
                  ? `oom_kill ${units.get(NodePath.basename(NodePath.dirname(file)))?.oomKills ?? 0}\n`
                  : "",
              )
            : fileSystem.readFileString(file, encoding),
      }),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: bin, XDG_RUNTIME_DIR: "/run/user/1" }),
    );
    return yield* body({ scope, units }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(bin, { recursive: true, force: true }))),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const unitOf = (launch: { readonly args: ReadonlyArray<string> }) =>
  launch.args.find((arg) => arg.startsWith("--unit="))?.slice("--unit=".length) ?? "";

// Starts the Codex app-server the way its adapter does.
const launchCodex = (scope: AgentScopeShape, threadId: string) =>
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
        // The older scope was OOM-killed, but the newest one is still running.
        expect(yield* scope.oomKilled("a")).toBe(false);

        units.set(unitOf(second), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("a")).toBe(true);
        // A retried failure reads the same, even after the failed unit is reset.
        units.delete(unitOf(second));
        expect(yield* scope.oomKilled("a")).toBe(true);

        // The next session may run without a scope, for example on Cursor.
        yield* scope.clear("a");
        expect(yield* scope.oomKilled("a")).toBe(false);
      }),
    ),
  );

  it.effect("launches the shared Codex app-server with OOMPolicy=continue", () =>
    withFakeSystemd(({ scope }) =>
      Effect.gen(function* () {
        const codex = yield* launchCodex(scope, "a");
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "b" });
        // OOMPolicy=stop would end the app-server of every Codex thread.
        expect(codex.args).toContain("--property=OOMPolicy=continue");
        expect(codex.args).not.toContain("--property=OOMPolicy=stop");
        // No thread reads a shared scope's result, so systemd may unload it.
        expect(codex.args).toContain("--collect");
        expect(agent.args).toContain("--property=OOMPolicy=stop");
      }),
    ),
  );

  it.effect("does not wait on a shared scope that outlived an OOM kill", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(agent), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("a")).toBe(true);

        // The thread moves to the shared app-server, and the kernel kills one
        // of its tools. The scope keeps running and never records an OOM kill.
        const codex = yield* launchCodex(scope, "a");
        units.set(unitOf(codex), { activeState: "active", result: "success", oomKills: 1 });
        const answer = yield* scope
          .oomKilled("a")
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect(answer.pollUnsafe(), "answers without waiting for a stop").toBeDefined();
        expect(yield* Fiber.join(answer)).toBe(false);
      }),
    ),
  );

  it.effect("labels the shared Codex app-server's OOM kill on systemd without OOMPolicy", () =>
    withFakeSystemd(
      ({ scope, units }) =>
        Effect.gen(function* () {
          const codex = yield* launchCodex(scope, "a");
          // systemd 252 still stops a plain scope on an OOM kill and records it.
          units.set(unitOf(codex), { activeState: "failed", result: "oom-kill" });
          expect(yield* scope.oomKilled("a")).toBe(true);
          expect(codex.args.filter((arg) => arg.includes("OOMPolicy"))).toEqual([]);
          expect(codex.args).not.toContain("--collect");
        }),
      { oomPolicy: false },
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
});
