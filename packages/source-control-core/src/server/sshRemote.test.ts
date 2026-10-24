import { VcsProcessTimeoutError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import { resolveSshRemoteUrl } from "./sshRemote.ts";

it.effect("resolves GitHub.com aliases and preserves other hosting endpoints", () =>
  Effect.gen(function* () {
    for (const [remoteUrl, hostname, expected] of [
      [
        "git@github.com-work:example/project.git",
        "github.com",
        "git@github.com:example/project.git",
      ],
      [
        "ssh://git@work:2222/example/project.git",
        "github.example.test",
        "ssh://git@work:2222/example/project.git",
      ],
      ["git@work:example/project.git", "gitlab.com", "git@work:example/project.git"],
      [
        "ssh://git@work:2222/group/../project%20name.git",
        "github.com",
        "ssh://git@github.com:2222/group/../project%20name.git",
      ],
      ["git@work:group/project name.git", "github.com", "git@github.com:group/project name.git"],
    ] as const) {
      const result = yield* resolveSshRemoteUrl({
        remoteUrl,
        cwd: "/repo",
        process: {
          run: () =>
            Effect.succeed({
              stdout: `hostname ${hostname}\n`,
              stderr: "",
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        },
      });
      expect(result).toBe(expected);
    }
  }),
);

it.effect("leaves HTTPS remotes alone and keeps SSH URLs when resolution fails", () =>
  Effect.gen(function* () {
    const remoteUrl = "https://github.com-work/example/project.git";
    const result = yield* resolveSshRemoteUrl({
      remoteUrl,
      cwd: "/repo",
      process: { run: () => Effect.die("HTTPS must not invoke ssh") },
    });
    expect(result).toBe(remoteUrl);
    const ssh = "git@github.com-work:example/project.git";
    expect(
      yield* resolveSshRemoteUrl({
        remoteUrl: ssh,
        cwd: "/repo",
        process: {
          run: () =>
            Effect.fail(
              new VcsProcessTimeoutError({
                operation: "test",
                command: "ssh",
                cwd: "/repo",
                timeoutMs: 5000,
              }),
            ),
        },
      }),
    ).toBe(ssh);
  }),
);

it.effect("keeps the original remote when SSH has no usable hostname", () =>
  Effect.gen(function* () {
    const remoteUrl = "ssh://git@work:2222/example/project.git";
    for (const [stdout, exitCode] of [
      ["user git\n", 0],
      ["hostname -bad-host\n", 0],
      ["hostname github.com\n", 1],
    ] as const) {
      expect(
        yield* resolveSshRemoteUrl({
          remoteUrl,
          cwd: "/repo with spaces",
          process: {
            run: () =>
              Effect.succeed({
                stdout,
                stderr: "",
                exitCode: ChildProcessSpawner.ExitCode(exitCode),
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
          },
        }),
      ).toBe(remoteUrl);
    }
  }),
);

it.effect("reads the SSH URL's user, alias, and transport port", () =>
  Effect.gen(function* () {
    const remoteUrl = "ssh://git@github.com-work:2222/example/project.git";
    const result = yield* resolveSshRemoteUrl({
      remoteUrl,
      cwd: "/repo with spaces",
      process: {
        run: (input) => {
          expect(input.args).toEqual(["-G", "-l", "git", "-p", "2222", "github.com-work"]);
          return Effect.succeed({
            stdout: "hostname github.com\n",
            stderr: "",
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        },
      },
    });
    expect(result).toBe("ssh://git@github.com:2222/example/project.git");
  }),
);

it.effect("keeps public API hosts when SSH uses an alternate endpoint or IP address", () =>
  Effect.gen(function* () {
    for (const hostname of ["github.com", "gitlab.com", "bitbucket.org"]) {
      const remoteUrl = `git@${hostname}:example/project.git`;
      expect(
        yield* resolveSshRemoteUrl({
          remoteUrl,
          cwd: "/repo",
          process: { run: () => Effect.die("Known API hosts do not need SSH resolution") },
        }),
      ).toBe(remoteUrl);
    }
    for (const [hostname, expectedHost] of [
      ["ssh.github.com", "github.com"],
      ["altssh.gitlab.com", "work"],
      ["altssh.bitbucket.org", "work"],
      ["ssh.github.example.test", "work"],
      ["gitea.example.test", "work"],
      ["192.0.2.1", "work"],
    ]) {
      expect(
        yield* resolveSshRemoteUrl({
          remoteUrl: "git@work:example/project.git",
          cwd: "/repo",
          process: {
            run: () =>
              Effect.succeed({
                stdout: `hostname ${hostname}\r\n`,
                stderr: "",
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
          },
        }),
      ).toBe(`git@${expectedHost}:example/project.git`);
    }
  }),
);

it.effect("caches SSH hostnames for 30 seconds while preserving each repository path", () =>
  Effect.gen(function* () {
    let calls = 0;
    const process = {
      run: () =>
        Effect.sync(() => {
          calls++;
          return {
            stdout: "hostname github.com\n",
            stderr: "",
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    };
    const resolve = (remoteUrl: string, cwd = "/repo") =>
      resolveSshRemoteUrl({ remoteUrl, cwd, process });
    yield* resolve("git@alias:example/one.git");
    yield* TestClock.adjust("29 seconds");
    expect(yield* resolve("git@alias:example/two.git")).toBe("git@github.com:example/two.git");
    expect(calls).toBe(1);
    yield* TestClock.adjust("1 second");
    yield* resolve("git@alias:example/one.git");
    expect(calls).toBe(2);
    yield* resolve("git@alias:example/one.git", "/other");
    yield* resolve("other@alias:example/one.git");
    yield* resolve("ssh://git@alias:2222/example/one.git");
    yield* resolve("git@other-alias:example/one.git");
    expect(calls).toBe(6);
  }),
);

it.effect("retries failed SSH lookups immediately", () =>
  Effect.gen(function* () {
    for (const failure of ["exit", "missing", "error"] as const) {
      let calls = 0;
      const process = {
        run: () =>
          Effect.suspend(() => {
            calls++;
            if (calls === 1 && failure === "error")
              return Effect.fail(
                new VcsProcessTimeoutError({
                  operation: "test",
                  command: "ssh",
                  cwd: "/repo",
                  timeoutMs: 5000,
                }),
              );
            return Effect.succeed({
              stdout: calls === 1 && failure === "missing" ? "user git\n" : "hostname github.com\n",
              stderr: "",
              exitCode: ChildProcessSpawner.ExitCode(calls === 1 && failure === "exit" ? 1 : 0),
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          }),
      };
      const input = { remoteUrl: "git@alias:example/project.git", cwd: "/repo", process };
      expect(yield* resolveSshRemoteUrl(input)).toBe(input.remoteUrl);
      expect(yield* resolveSshRemoteUrl(input)).toBe("git@github.com:example/project.git");
      expect(calls).toBe(2);
    }
  }),
);
