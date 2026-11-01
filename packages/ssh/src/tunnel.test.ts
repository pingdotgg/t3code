import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { resolveSshTarget } from "./command.ts";
import { SshCommandError, SshPasswordPromptError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;

describe("ssh tunnel scripts", () => {
  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => SshTunnel.buildRemoteT3RunnerScript({ archiveVersion }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteT3RunnerScript(ARCHIVE),
      "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 1);
            assert.equal(result.failure.stderr.length, 16_384);
            assert.isTrue(result.failure.stderr.endsWith(diagnostic));
            assert.equal(result.failure.message, result.failure.stderr.trim());
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reports the real exit when reading tunnel diagnostics fails", () =>
    Effect.gen(function* () {
      const diagnostic = "Permission denied (publickey)";
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(diagnostic)).pipe(
                  Stream.concat(
                    Stream.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "Stream",
                        method: "read",
                        description: "stderr read failed",
                      }),
                    ),
                  ),
                ),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 255);
            assert.equal(result.failure.stderr, diagnostic);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each([
    { mode: "disconnect first", cleanup: "bootstrap" },
    { mode: "resolve before disconnect", cleanup: "bootstrap" },
    { mode: "failed stop", cleanup: "bootstrap" },
    { mode: "disconnect first", cleanup: "legacy" },
    { mode: "resolve before disconnect", cleanup: "legacy" },
    { mode: "failed stop", cleanup: "legacy" },
    { mode: "disconnect first", cleanup: "stale" },
    { mode: "resolve before disconnect", cleanup: "stale" },
    { mode: "failed stop", cleanup: "stale" },
  ] as const)(
    "keeps cleanup bound to the connected host after alias routing changes: $mode / $cleanup",
    ({ mode, cleanup }) => {
      let recovered = false;
      let resolutions = 0;
      let kills = 0;
      const stops: Array<ReadonlyArray<string>> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = commandArgs(command);
          if (args.includes("-G")) {
            resolutions += 1;
            return makeSuccessfulProcess(
              `hostname ${recovered ? "other.example.com" : "connected.example.com"}\nuser alice\nport 2222\n`,
            );
          }
          if (args.includes("-N"))
            return makeRunningProcess(() => {
              kills += 1;
            });
          if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          stops.push(args);
          const stop = makeSuccessfulProcess('{"stopped":true}\n');
          return mode === "failed stop" && stops.length === 1
            ? { ...stop, exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)) }
            : stop;
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const request = {
          alias: "devbox",
          hostname: cleanup === "stale" ? "previous.example.com" : "devbox",
          username: null,
          port: null,
        };
        const connected = yield* manager.ensureEnvironment(request);
        const cleanupTarget = cleanup === "bootstrap" ? connected.target : request;
        assert.equal(connected.target.hostname, "connected.example.com");
        recovered = true;
        if (mode === "resolve before disconnect") {
          assert.equal((yield* resolveSshTarget("devbox")).hostname, "other.example.com");
        }
        const result = yield* Effect.result(manager.disconnectEnvironment(cleanupTarget));
        if (mode === "failed stop") {
          assert.isTrue(Result.isFailure(result));
          yield* manager.disconnectEnvironment(cleanupTarget);
        } else {
          assert.isTrue(Result.isSuccess(result));
        }
        assert.equal(kills, 1);
        assert.equal(resolutions, mode === "resolve before disconnect" ? 2 : 1);
        assert.equal(stops.length, mode === "failed stop" ? 2 : 1);
        for (const args of stops) {
          assert.include(args, "HostName=connected.example.com");
          assert.include(args, "alice@devbox");
          assert.deepEqual(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2), ["-p", "2222"]);
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
  );

  it.effect.each(["resolution", "pairing", "failed pairing", "failed launch"] as const)(
    "keeps cleanup bound while preparation is pending at %s",
    (stage) =>
      Effect.gen(function* () {
        const paused = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const pause = Deferred.succeed(paused, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
        );
        let kills = 0;
        let resolutions = 0;
        const stops: Array<ReadonlyArray<string>> = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            if (args.includes("-G")) {
              resolutions += 1;
              const result = makeSuccessfulProcess(
                `hostname ${resolutions === 1 ? "connected.example.com" : "other.example.com"}\nuser alice\nport 2222\n`,
              );
              return stage === "resolution"
                ? { ...result, exitCode: pause.pipe(Effect.andThen(result.exitCode)) }
                : result;
            }
            if (args.includes("-N"))
              return makeRunningProcess(() => {
                kills += 1;
              });
            if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
              const result = makeSuccessfulProcess('{"remotePort":3773}\n');
              return stage === "failed launch"
                ? { ...result, exitCode: pause.pipe(Effect.as(ChildProcessSpawner.ExitCode(1))) }
                : result;
            }
            if (args.some((arg) => arg.startsWith("HostName="))) {
              stops.push(args);
              return makeSuccessfulProcess('{"stopped":true}\n');
            }
            const result = makeSuccessfulProcess('{"credential":"pairing-token"}\n');
            return {
              ...result,
              exitCode: pause.pipe(
                Effect.as(ChildProcessSpawner.ExitCode(stage === "failed pairing" ? 1 : 0)),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const request = { alias: "devbox", hostname: "devbox", username: null, port: null };
          const preparing = yield* Effect.forkChild(
            Effect.result(
              manager.ensureEnvironment(request, {
                issuePairingToken: stage !== "resolution",
              }),
            ),
          );
          yield* Deferred.await(paused);
          const stopping = yield* Effect.forkChild(manager.disconnectEnvironment(request), {
            startImmediately: true,
          });
          yield* TestClock.adjust(Duration.zero);
          const stopsWhilePreparing = stops.length;
          yield* Deferred.succeed(resume, undefined);
          const prepared = yield* Fiber.join(preparing);
          yield* Fiber.join(stopping);
          assert.equal(stopsWhilePreparing, 0);
          assert.equal(
            prepared._tag,
            stage === "failed pairing" || stage === "failed launch" ? "Failure" : "Success",
          );
          assert.equal(kills, stage === "failed launch" ? 0 : 1);
          assert.equal(resolutions, 1);
          assert.equal(stops.length, 1);
          assert.include(stops[0]!, "HostName=connected.example.com");
          assert.include(stops[0]!, "alice@devbox");
        }).pipe(
          Effect.ensuring(Deferred.succeed(resume, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );

  it.effect.each([
    "original request",
    "persisted bootstrap",
    "latest bootstrap",
    "converging profiles",
    "failed first stop",
    "canonical before legacy",
  ] as const)(
    "keeps cleanup bound to every host prepared for a request, not another alias: %s",
    (nextRequest) =>
      Effect.gen(function* () {
        let recovered = nextRequest === "canonical before legacy";
        let hostname: string | undefined;
        const killed: string[] = [];
        const stops: Array<ReadonlyArray<string>> = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            if (args.includes("-G"))
              return makeSuccessfulProcess(
                `hostname ${hostname ?? (recovered ? "second.example.com" : "first.example.com")}\nuser alice\nport 2222\n`,
              );
            if (args.includes("-N"))
              return makeRunningProcess(() => {
                killed.push(args.at(-1) ?? "");
              });
            if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            stops.push(args);
            const result = makeSuccessfulProcess('{"stopped":true}\n');
            return nextRequest === "failed first stop" && stops.length === 1
              ? { ...result, exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)) }
              : result;
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const request = { alias: "devbox", hostname: "devbox", username: null, port: null };
          const initialRequest =
            nextRequest === "canonical before legacy"
              ? { ...request, hostname: "first.example.com", username: "alice", port: 2222 }
              : request;
          const first = yield* manager.ensureEnvironment(initialRequest);
          recovered = nextRequest !== "canonical before legacy";
          const cleanupTarget =
            nextRequest === "persisted bootstrap" || nextRequest === "latest bootstrap"
              ? first.target
              : initialRequest;
          const second = yield* manager.ensureEnvironment(
            nextRequest === "canonical before legacy" ? request : cleanupTarget,
          );
          recovered = true;
          const expectedHosts = ["first.example.com", "second.example.com"];
          if (nextRequest === "converging profiles") {
            hostname = "third.example.com";
            const stale = yield* manager.ensureEnvironment({
              ...request,
              hostname: "stale.example.com",
              username: "alice",
              port: 2222,
            });
            hostname = "second.example.com";
            yield* manager.ensureEnvironment(stale.target);
            hostname = undefined;
            expectedHosts.push("third.example.com");
          }
          const other = yield* manager.ensureEnvironment({
            ...request,
            alias: "other",
            hostname: "other",
          });
          assert.equal(
            first.target.hostname,
            nextRequest === "canonical before legacy" ? "second.example.com" : "first.example.com",
          );
          assert.equal(
            second.target.hostname,
            nextRequest === "canonical before legacy" ? "first.example.com" : "second.example.com",
          );
          assert.equal(other.target.hostname, "second.example.com");
          const anotherUser = yield* manager.ensureEnvironment({
            ...request,
            username: "bob",
            port: 3333,
          });
          assert.equal(anotherUser.target.username, "bob");
          assert.equal(anotherUser.target.port, 3333);
          const result = yield* Effect.result(
            manager.disconnectEnvironment(
              nextRequest === "latest bootstrap" || nextRequest === "converging profiles"
                ? second.target
                : cleanupTarget,
            ),
          );
          assert.equal(result._tag, nextRequest === "failed first stop" ? "Failure" : "Success");
          assert.deepEqual(
            killed,
            expectedHosts.map(() => "alice@devbox"),
          );
          assert.equal(stops.length, expectedHosts.length);
          assert.deepEqual(
            stops.flatMap((args) => args.filter((arg) => arg.startsWith("HostName="))).toSorted(),
            expectedHosts.map((host) => `HostName=${host}`).toSorted(),
          );
          assert.include(stops[0]!, "alice@devbox");
          assert.include(stops[1]!, "alice@devbox");
          if (nextRequest === "failed first stop") {
            yield* manager.disconnectEnvironment(cleanupTarget);
            assert.equal(stops.length, 3);
            assert.include(stops[2]!, "HostName=first.example.com");
            assert.deepEqual(killed, ["alice@devbox", "alice@devbox"]);
          }
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
  );

  it.effect.each([
    "legacy",
    "legacy failed stop",
    "legacy failed resolution",
    "canonical",
    "canonical same name",
  ] as const)("cleans a cold %s profile without redirecting canonical targets", (profile) => {
    const legacy = profile.startsWith("legacy");
    let resolutions = 0;
    const stops: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (args.includes("-G")) {
          resolutions += 1;
          const result = makeSuccessfulProcess(
            "hostname connected.example.com\nuser alice\nport 2222\n",
          );
          return profile === "legacy failed resolution" && resolutions === 1
            ? { ...result, exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)) }
            : result;
        }
        stops.push(args);
        const result = makeSuccessfulProcess('{"stopped":true}\n');
        return (profile === "legacy failed stop" || profile === "legacy failed resolution") &&
          stops.length === 1
          ? { ...result, exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)) }
          : result;
      }),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshAuth.SshPasswordPrompt.disabledLayer,
      SshTunnel.SshEnvironmentManager.layer(),
    );
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const target = legacy
        ? { alias: "devbox", hostname: "devbox", username: null, port: null }
        : {
            alias: "devbox",
            hostname: profile === "canonical same name" ? "devbox" : "saved.example.com",
            username: "bob",
            port: 3333,
          };
      const first = yield* Effect.result(manager.disconnectEnvironment(target));
      assert.equal(
        first._tag,
        profile === "legacy failed stop" || profile === "legacy failed resolution"
          ? "Failure"
          : "Success",
      );
      if (legacy) yield* manager.disconnectEnvironment(target);
      assert.equal(resolutions, profile === "legacy failed resolution" ? 2 : legacy ? 1 : 0);
      assert.equal(stops.length, legacy ? 2 : 1);
      for (const args of profile === "legacy failed resolution" ? stops.slice(1) : stops)
        assert.include(
          args,
          legacy
            ? "HostName=connected.example.com"
            : profile === "canonical same name"
              ? "HostName=devbox"
              : "HostName=saved.example.com",
        );
      assert.include(stops.at(-1)!, legacy ? "alice@devbox" : "bob@devbox");
      assert.deepEqual(
        stops.at(-1)!.slice(stops.at(-1)!.indexOf("-p"), stops.at(-1)!.indexOf("-p") + 2),
        ["-p", legacy ? "2222" : "3333"],
      );
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect.each([
    {
      name: "does not ask for a password when the agent cannot sign an accepted key",
      stderr:
        'sign_and_send_pubkey: signing failed for ED25519 "/home/julius/.ssh/id_ed25519" from agent: communication with agent failed\r\n' +
        "julius@devbox: Permission denied (publickey,password).\r\n",
      expectedPromptAttempts: [],
    },
    {
      name: "asks for a password when signing failure has no agent provenance",
      stderr:
        'sign_and_send_pubkey: signing failed for ED25519-CERT "key-cert.pub": agent refused operation\n' +
        "julius@devbox: Permission denied (publickey,password).\n",
      expectedPromptAttempts: [1],
    },
    {
      name: "asks for a password when the server rejects every key",
      stderr: "julius@devbox: Permission denied (publickey,password).\r\n",
      expectedPromptAttempts: [1],
    },
  ])("$name", ({ stderr, expectedPromptAttempts }) =>
    Effect.gen(function* () {
      const promptAttempts: Array<number> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-G")
            ? makeSuccessfulProcess("")
            : {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(stderr)),
              },
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        Layer.succeed(
          SshAuth.SshPasswordPrompt,
          SshAuth.SshPasswordPrompt.of({
            isAvailable: true,
            request: (request) =>
              Effect.sync(() => {
                promptAttempts.push(request.attempt);
                return null;
              }),
          }),
        ),
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        assert.deepEqual(promptAttempts, expectedPromptAttempts);
        if (Result.isFailure(result)) {
          if (expectedPromptAttempts.length === 0) {
            assert.instanceOf(result.failure, SshCommandError);
            if (result.failure instanceof SshCommandError) {
              assert.equal(result.failure.stderr, stderr);
            }
          } else {
            assert.instanceOf(result.failure, SshPasswordPromptError);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let resolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              if (isTarget) resolutions += 1;
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target), {
            startImmediately: true,
          });
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target), {
            startImmediately: true,
          });

          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          const resolutionsBeforeShutdown = resolutions;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);

          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(resolutionsBeforeShutdown, 1);
          assert.equal(resolutions, 3);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );
});

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too.
