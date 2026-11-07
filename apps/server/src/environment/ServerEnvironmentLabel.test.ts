import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

it.effect.each(
  [undefined, "", " ", "\t\r\n", "  "].flatMap((override) =>
    [
      {
        machineInfo: 'PRETTY_HOSTNAME=" Friendly host "\n',
        command: "Other host",
        hostname: "host",
        cwd: "project",
        expected: "Friendly host",
      },
      {
        machineInfo: "",
        command: " Command host\n",
        hostname: "host",
        cwd: "project",
        expected: "Command host",
      },
      { machineInfo: "", command: "", hostname: " host ", cwd: "project", expected: "host" },
      { machineInfo: "", command: "", hostname: " \t", cwd: " project ", expected: "project" },
      { machineInfo: "", command: "", hostname: "", cwd: "\t", expected: "T3 environment" },
    ].map((host) => ({ ...host, override })),
  ),
)("keeps fallback $expected for unset or blank override '$override'", (host) =>
  Effect.gen(function* () {
    const label = yield* resolveServerEnvironmentLabel({ cwdBaseName: host.cwd }).pipe(
      Effect.provideService(HostProcess.Environment, { T3CODE_ENVIRONMENT_LABEL: host.override }),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Hostname, host.hostname),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: () => Effect.succeed(host.machineInfo !== ""),
          readFileString: () => Effect.succeed(host.machineInfo),
        }),
      ),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () =>
          Effect.succeed({
            stdout: host.command,
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      }),
    );

    expect(label).toBe(host.expected);
  }),
);

it.effect.each(
  (["linux", "darwin", "win32"] as const).flatMap((platform) =>
    [
      { username: "personal", override: "  Personal workspace \t", expected: "Personal workspace" },
      { username: "work", override: "\n仕事用 🛠️ ", expected: "仕事用 🛠️" },
    ].map((account) => ({ ...account, platform })),
  ),
)("uses the explicit label for $username on $platform without host probes", (account) =>
  Effect.gen(function* () {
    const label = yield* resolveServerEnvironmentLabel({ cwdBaseName: "same-project" }).pipe(
      Effect.provideService(HostProcess.Environment, {
        T3CODE_ENVIRONMENT_LABEL: account.override,
      }),
      Effect.provideService(HostProcess.Platform, account.platform),
      Effect.provideService(HostProcess.Hostname, "same-host"),
      Effect.provideService(HostProcess.Username, account.username),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: () => Effect.die("Explicit labels must not inspect host files"),
          readFileString: () => Effect.die("Explicit labels must not read host files"),
        }),
      ),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.die("Explicit labels must not spawn host probes"),
      }),
    );

    expect(label).toBe(account.expected);
  }),
);
