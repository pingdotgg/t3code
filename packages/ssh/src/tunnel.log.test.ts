import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { remoteStateKey } from "./command.ts";
import { SshCommandError } from "./errors.ts";
import { buildRemoteLogTailScript, launchOrReuseRemoteServer } from "./tunnel.ts";

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "reports only the current SSH launch log in node and archive modes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const environment = yield* HostProcess.Environment;
      const executable = yield* HostProcess.ExecutablePath;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-log-" });
      const target = { alias: "fixture", hostname: "fixture", username: null, port: null };
      const stateKey = yield* remoteStateKey(target);
      for (const [mode, diagnostic] of [
        ["node", false],
        ["archive", false],
        ["node", true],
        ["archive", true],
      ] as const) {
        const scenario = path.join(root, `${mode}-${diagnostic ? "diagnostic" : "empty"}`);
        const home = path.join(scenario, "home");
        const state = path.join(home, ".t3", "ssh-launch", stateKey);
        const bin = path.join(scenario, "bin");
        yield* fs.makeDirectory(state, { recursive: true });
        yield* fs.makeDirectory(bin);
        const legacyLog = path.join(state, "server.log");
        yield* fs.writeFileString(legacyLog, "STALE_DIAGNOSTIC\n");
        const fifo = path.join(scenario, "ready.fifo");
        if (diagnostic) {
          const makeFifo = yield* spawner.spawn(ChildProcess.make("mkfifo", [fifo]));
          assert.equal(Number(yield* makeFifo.exitCode), 0);
        }
        const fixture = path.join(scenario, "fake-t3.sh");
        const fixtureScript =
          '#!/bin/sh\ncase "$1" in\n  --version) echo 1.2.3 ;;\n  __ssh-helper) case "$2" in\n    pick-port) echo 37731 ;;\n    wait-ready) if [ -n "$T3_TEST_LOG_FIFO" ]; then printf "ready\\n" > "$T3_TEST_LOG_FIFO"; fi; exit 1 ;;\n    runtime-port) exit 1 ;;\n  esac ;;\n  serve) if [ -n "$T3_TEST_LOG_FIFO" ]; then printf "CURRENT_DIAGNOSTIC\\n"; read -r ready < "$T3_TEST_LOG_FIFO"; fi; exit 0 ;;\nesac\n';
        yield* fs.writeFileString(fixture, fixtureScript, { mode: 0o700 });
        yield* fs.writeFileString(
          path.join(bin, "node"),
          '#!/bin/sh\nif [ "$1" = "-" ]; then\n  case "$3" in 3773) cat >/dev/null; echo 37731; exit 0 ;; esac\n  cat >/dev/null; if [ "$2" = "37731" ] && [ -n "$T3_TEST_LOG_FIFO" ]; then printf "ready\\n" > "$T3_TEST_LOG_FIFO"; fi; exit 1\nfi\nif [ "$1" = "-e" ]; then exec "$T3_TEST_REAL_NODE" "$@"; fi\nexec sh "$@"\n',
          { mode: 0o700 },
        );
        if (mode === "archive") {
          const installed = path.join(home, ".t3", "runtime", "versions", "1.2.3");
          yield* fs.makeDirectory(installed, { recursive: true });
          yield* fs.writeFileString(path.join(installed, "t3"), fixtureScript, { mode: 0o700 });
          yield* fs.writeFileString(path.join(installed, ".install-complete"), "1.2.3\n");
        }
        // Execute the service's SSH payload locally against fake runners, never a remote host.
        const localSsh = ChildProcessSpawner.make((command) => {
          assert.isTrue(ChildProcess.isStandardCommand(command));
          if (!ChildProcess.isStandardCommand(command)) {
            return Effect.die("Expected a standard SSH command");
          }
          return spawner.spawn(
            ChildProcess.make(
              "sh",
              [
                "-c",
                'exec 3>>"$1"; sh -s -- "$2"; status=$?; printf "LATE_OLD_DESCRIPTOR\\n" >&3; exit "$status"',
                "sh",
                legacyLog,
                stateKey,
              ],
              {
                stdin: command.options.stdin,
                env: {
                  HOME: home,
                  PATH: `${bin}:${environment.PATH ?? "/usr/bin:/bin"}`,
                  T3_TEST_REAL_NODE: executable,
                  T3_TEST_LOG_FIFO: diagnostic ? fifo : "",
                },
                extendEnv: false,
              },
            ),
          );
        });
        const result = yield* launchOrReuseRemoteServer(
          target,
          undefined,
          mode === "node" ? { nodeScriptPath: fixture } : { archiveVersion: "1.2.3" },
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, localSsh),
          Effect.result,
        );
        assert.isTrue(Result.isFailure(result));
        if (!Result.isFailure(result) || !(result.failure instanceof SshCommandError)) {
          return yield* Effect.die("Expected the failed launch's SSH diagnostic");
        }
        const { stderr, exitCode } = result.failure;
        const [logPid, logBasename] = (yield* fs.readFileString(path.join(state, "current-log")))
          .trimEnd()
          .split("\n");
        const currentLog = path.join(state, logBasename!);
        assert.equal(exitCode, 1, stderr);
        assert.notInclude(stderr, "STALE_DIAGNOSTIC");
        assert.include(stderr, diagnostic ? "CURRENT_DIAGNOSTIC" : "It wrote nothing to");
        assert.match(logBasename ?? "", /^server\.log\.[A-Za-z0-9]{8}$/u);
        assert.equal(
          yield* fs.readFileString(currentLog),
          diagnostic ? "CURRENT_DIAGNOSTIC\n" : "",
        );
        assert.equal(
          yield* fs.readFileString(legacyLog),
          "STALE_DIAGNOSTIC\nLATE_OLD_DESCRIPTOR\n",
        );
        assert.match(logPid ?? "", /^\d+$/u);

        yield* fs.writeFileString(currentLog, "CURRENT_LOG\n");
        const pointer = path.join(state, "current-log");
        const pid = path.join(state, "pid");
        const managed = path.join(state, "managed");
        yield* fs.writeFileString(pid, `${logPid}\n`);
        const runTail = Effect.gen(function* () {
          const tail = yield* spawner.spawn(
            ChildProcess.make("sh", ["-c", buildRemoteLogTailScript(stateKey)], {
              env: { HOME: home, PATH: environment.PATH ?? "/usr/bin:/bin" },
              extendEnv: false,
            }),
          );
          const [stdout, stderr, code] = yield* Effect.all(
            [
              tail.stdout.pipe(
                Stream.decodeText(),
                Stream.runFold(
                  () => "",
                  (s, c) => s + c,
                ),
              ),
              tail.stderr.pipe(
                Stream.decodeText(),
                Stream.runFold(
                  () => "",
                  (s, c) => s + c,
                ),
              ),
              tail.exitCode.pipe(Effect.map(Number)),
            ],
            { concurrency: "unbounded" },
          );
          assert.equal(code, 0, stderr);
          return stdout;
        });
        const legacy = "STALE_DIAGNOSTIC\nLATE_OLD_DESCRIPTOR\n";
        assert.equal(yield* runTail, "CURRENT_LOG\n");
        for (const malformed of [
          "",
          `${logPid}\n`,
          `${logPid}\n${logBasename}`,
          `${logPid}\n${logBasename}\nextra\n`,
          `0\n${logBasename}\n`,
          `abc\n${logBasename}\n`,
          `${logPid}\nserver.log.../../other\n`,
          `${logPid}\n../server.log.Abc12345\n`,
          `${logPid}\nserver.log.Abc1234/\n`,
        ]) {
          yield* fs.writeFileString(pointer, malformed);
          assert.equal(yield* runTail, legacy, `malformed pointer: ${JSON.stringify(malformed)}`);
        }
        yield* fs.remove(pointer);
        assert.equal(yield* runTail, legacy);
        yield* fs.writeFileString(pointer, `${logPid}\n${logBasename}\n`);
        yield* fs.remove(pid);
        assert.equal(yield* runTail, "CURRENT_LOG\n");
        yield* fs.writeFileString(pid, `${Number(logPid) + 1}\n`);
        assert.equal(yield* runTail, legacy); // older client or publication gap
        yield* fs.writeFileString(pid, `${logPid}\n`);
        yield* fs.writeFileString(managed, "external\n");
        assert.equal(yield* runTail, legacy);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
