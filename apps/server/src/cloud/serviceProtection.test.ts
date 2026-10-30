// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as ServiceProtection from "./serviceProtection.ts";

const temporaryDirectory = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-service-protection-"));

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("renderPrivilegedScript", () => {
  it("writes and removes only its drop-ins and gives running main processes their score", () => {
    const root = temporaryDirectory();
    const target = NodeChildProcess.spawn("sleep", ["60"], { stdio: "ignore" });
    try {
      const systemUnitDir = NodePath.join(root, "system");
      const plan = (uid: number, remoteAccessUnits: ReadonlyArray<string>) =>
        ServiceProtection.protectionPlan({
          uid,
          userUnitDir: "/home/theo/.config/systemd/user",
          remoteAccessUnits,
          systemUnitDir,
        });
      const theo = plan(1000, ["tailscaled.service", "ssh.service"]);
      expect(theo.system.find((dropIn) => dropIn.unit === "user@1000.service")?.contents).toBe(
        "[Service]\nMemoryLow=2G\nOOMScoreAdjust=-900\n",
      );
      expect(theo.managerDefaults.path).toBe(
        "/home/theo/.config/systemd/user.conf.d/90-t3code-protect.conf",
      );
      expect(theo.oomUnits).toEqual(["user@1000.service", "tailscaled.service", "ssh.service"]);

      const unrelated = NodePath.join(systemUnitDir, "ssh.service.d", "50-admin.conf");
      NodeFS.mkdirSync(NodePath.dirname(unrelated), { recursive: true });
      NodeFS.writeFileSync(unrelated, "[Service]\nNice=1\n");
      const bin = NodePath.join(root, "bin");
      NodeFS.mkdirSync(bin);
      // Raising a score needs no privilege, so the test's own child stands in for a main process.
      NodeFS.writeFileSync(
        NodePath.join(bin, "systemctl"),
        [
          "#!/bin/sh",
          'echo "$*" >>"$CALLS"',
          'case "$*" in',
          '  *MainPID*) echo "$TARGET_PID" ;;',
          "  *OOMScoreAdjust*) echo 900 ;;",
          "esac",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const calls = NodePath.join(root, "calls");
      const runScript = (protection: ServiceProtection.ProtectionPlan, mode: "apply" | "undo") => {
        const result = NodeChildProcess.spawnSync(
          "/bin/sh",
          ["-c", ServiceProtection.renderPrivilegedScript(protection, mode)],
          {
            encoding: "utf8",
            env: {
              PATH: `${bin}:/usr/bin:/bin`,
              CALLS: calls,
              TARGET_PID: String(target.pid),
            },
          },
        );
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      };
      const exists = (unit: string) =>
        NodeFS.existsSync(NodePath.join(systemUnitDir, `${unit}.d`, "90-t3code-protect.conf"));

      runScript(theo, "apply");
      runScript(plan(1001, []), "apply");
      for (const { path, contents } of theo.system) {
        expect(NodeFS.readFileSync(path, "utf8")).toBe(contents);
      }
      expect(NodeFS.readFileSync(`/proc/${target.pid}/oom_score_adj`, "utf8").trim()).toBe("900");
      expect(NodeFS.readFileSync(calls, "utf8").split("\n")[0]).toBe("daemon-reload");

      // Undo removes every drop-in a user could own, and keeps shared ones while another user is protected.
      const undo = (uid: number) => plan(uid, ServiceProtection.REMOTE_ACCESS_UNITS);
      runScript(undo(1000), "undo");
      expect(["user-1000.slice", "user@1000.service"].some(exists)).toBe(false);
      expect(
        ["user.slice", "system.slice", "tailscaled.service", "ssh.service"].every(exists),
      ).toBe(true);

      runScript(undo(1001), "undo");
      for (const { path } of undo(1001).system) expect(NodeFS.existsSync(path)).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(systemUnitDir, "user.slice.d"))).toBe(false);
      expect(NodeFS.readFileSync(unrelated, "utf8")).toBe("[Service]\nNice=1\n");
    } finally {
      target.kill();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});

it.each([
  [
    "Debian, where sshd.service aliases ssh.service",
    "Id=tailscaled.service\nLoadState=loaded\n\nId=ssh.service\nLoadState=loaded\n\nId=ssh.service\nLoadState=loaded\n",
    ["tailscaled.service", "ssh.service"],
  ],
  [
    "Fedora without Tailscale",
    "Id=tailscaled.service\nLoadState=not-found\n\nId=ssh.service\nLoadState=not-found\n\nId=sshd.service\nLoadState=loaded\n",
    ["sshd.service"],
  ],
])("finds remote-access services on %s", (_, shown, expected) => {
  expect(ServiceProtection.loadedRemoteAccessUnits(shown)).toEqual(expected);
});

const fakeSudo = (exitCode: number, onRun: () => void) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand" || command.command !== "sudo") {
        return yield* Effect.die("Unexpected command");
      }
      onRun();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );

const runner = (stdout: string) =>
  ProcessRunner.ProcessRunner.of({
    run: () =>
      Effect.succeed({
        stdout,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });

it.effect("lowers no score before the manager default is in place, and undoes in reverse", () => {
  const home = temporaryDirectory();
  return Effect.gen(function* () {
    const plan = ServiceProtection.protectionPlan({
      uid: 1000,
      userUnitDir: NodePath.join(home, ".config", "systemd", "user"),
      remoteAccessUnits: [],
      systemUnitDir: NodePath.join(home, "system"),
    });
    const managerDropIn = plan.system.find(({ unit }) => unit === "user@1000.service")!.path;
    const present = () => ({
      managerDefaults: NodeFS.existsSync(plan.managerDefaults.path),
      user: plan.user.filter(({ path }) => NodeFS.existsSync(path)).length,
    });
    const withSudo = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      exitCode: number,
      writesManagerDropIn = false,
    ) => {
      let atSudo: ReturnType<typeof present> | undefined;
      return effect.pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          fakeSudo(exitCode, () => {
            atSudo = present();
            if (writesManagerDropIn) {
              NodeFS.mkdirSync(NodePath.dirname(managerDropIn), { recursive: true });
              NodeFS.writeFileSync(managerDropIn, "[Service]\nOOMScoreAdjust=-900\n");
            }
          }),
        ),
        Effect.exit,
        Effect.map((exit) => ({ exit, atSudo })),
      );
    };
    const refused = yield* withSudo(ServiceProtection.applyProtection(plan), 1);
    expect(refused.exit._tag).toBe("Failure");
    expect(refused.atSudo).toEqual({ managerDefaults: true, user: 0 });
    expect(present()).toEqual({ managerDefaults: false, user: 0 });

    // Failing after it lowered the manager, sudo must leave the manager default in place.
    const partial = yield* withSudo(ServiceProtection.applyProtection(plan), 1, true);
    expect(partial.exit._tag).toBe("Failure");
    expect(present()).toEqual({ managerDefaults: true, user: 0 });
    NodeFS.rmSync(plan.managerDefaults.path);
    NodeFS.rmSync(managerDropIn);

    const applied = yield* withSudo(ServiceProtection.applyProtection(plan), 0);
    expect(applied.atSudo).toEqual({ managerDefaults: true, user: 0 });
    expect(present()).toEqual({ managerDefaults: true, user: plan.user.length });

    const removed = yield* withSudo(ServiceProtection.removeProtection(plan), 0);
    expect(removed.atSudo).toEqual({ managerDefaults: true, user: 0 });
    expect(present()).toEqual({ managerDefaults: false, user: 0 });
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
    Effect.provideService(ProcessRunner.ProcessRunner, runner("")),
    Effect.provide(NodeServices.layer),
  );
});

it.effect("counts memory.min as protection and names the first cgroup that grants none", () => {
  const root = temporaryDirectory();
  const controlGroup = [
    "user.slice",
    "user-1000.slice",
    "user@1000.service",
    "app.slice",
    "t3code.service",
  ];
  const write = (depth: number, file: string, value: string) => {
    const directory = NodePath.join(root, ...controlGroup.slice(0, depth));
    NodeFS.mkdirSync(directory, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(directory, file), `${value}\n`);
  };
  write(1, "memory.low", "0");
  write(1, "memory.min", "805306368");
  write(2, "memory.low", "2147483648");
  write(3, "memory.low", "2147483648");
  write(4, "memory.low", "0");
  write(4, "memory.min", "0");
  write(5, "memory.low", "1610612736");
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const read = ServiceProtection.readProtection("/home/theo/.config/systemd/user").pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFileString: (path, encoding) =>
          fs.readFileString(path.replace("/sys/fs/cgroup", root), encoding),
      }),
    );
    expect((yield* read)?.unprotected).toBe("app.slice");
    write(4, "memory.low", "1610612736");
    expect((yield* read)?.unprotected).toBeUndefined();
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      runner(`ControlGroup=/${controlGroup.join("/")}\nMainPID=0\n`),
    ),
    Effect.provide(NodeServices.layer),
  );
});
