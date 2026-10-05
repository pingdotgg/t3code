import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as SshAuth from "./auth.ts";
import * as SshTunnel from "./tunnel.ts";
import { SshCommandError, SshReadinessError } from "./errors.ts";

const target = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};
const ready =
  "debug1: Local forwarding listening on 127.0.0.1 port 41773.\ndebug1: Entering interactive session.\n";
const bytes = (text: string) => new TextEncoder().encode(text);

const fixture = (
  options: {
    readonly stderr?: Stream.Stream<Uint8Array>;
    readonly running?: Effect.Effect<boolean>;
    readonly spawnGate?: Effect.Effect<void>;
    readonly stopGate?: Effect.Effect<void>;
    readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
    readonly preferredAvailable?: boolean;
    readonly portInUseAfterProbe?: number;
  } = {},
) => {
  const commands: ReadonlyArray<string>[] = [];
  let killed = 0;
  let nextPort = 41773;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];
      commands.push(args);
      const tunnel = args.includes("-N");
      const bindCollision =
        tunnel &&
        options.portInUseAfterProbe !== undefined &&
        args.some((arg) => arg.startsWith(`127.0.0.1:${options.portInUseAfterProbe}:`));
      if (tunnel && options.spawnGate) yield* options.spawnGate;
      if (!tunnel && !args.includes("-G") && options.stopGate) yield* options.stopGate;
      const stopped = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const stdout = Stream.make(bytes("hostname devbox.example.test\nuser developer\nport 22\n"));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        stdout,
        stderr: bindCollision
          ? Stream.make(
              bytes(
                `debug1: Local forwarding listening on 127.0.0.1 port ${options.portInUseAfterProbe}.\nbind [127.0.0.1]:${options.portInUseAfterProbe}: Address already in use\n`,
              ),
            )
          : tunnel
            ? (options.stderr ?? Stream.make(bytes(ready)))
            : Stream.empty,
        all: stdout,
        exitCode: bindCollision
          ? Effect.succeed(ChildProcessSpawner.ExitCode(255))
          : tunnel
            ? (options.exitCode ?? Deferred.await(stopped))
            : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: bindCollision
          ? Effect.succeed(false)
          : tunnel
            ? (options.running ?? Effect.succeed(true))
            : Effect.succeed(false),
        kill: () =>
          Effect.sync(() => {
            killed++;
          }).pipe(
            Effect.andThen(Deferred.succeed(stopped, ChildProcessSpawner.ExitCode(143))),
            Effect.asVoid,
          ),
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
      ),
    ),
    Layer.succeed(
      NetService.NetService,
      NetService.NetService.of({
        canListenOnHost: () => Effect.succeed(options.preferredAvailable ?? false),
        isPortAvailableOnLoopback: () => Effect.succeed(false),
        hasListenerOnHost: () => Effect.succeed(true),
        reserveLoopbackPort: () => Effect.sync(() => nextPort++),
        findAvailablePort: (port) => Effect.succeed(port),
      }),
    ),
    SshAuth.SshPasswordPrompt.disabledLayer,
    SshTunnel.SshEnvironmentManager.layer(),
  );
  return {
    layer,
    commands,
    kills: () => killed,
    spawns: () => commands.filter((args) => args.includes("-N")).length,
  };
};

describe("SSH preview port forwards", () => {
  it.effect("shares concurrent acquires, releases idempotently, and binds only loopback", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const [a, b] = yield* Effect.all(
        [manager.acquirePortForward(target, 5173), manager.acquirePortForward(target, 5173)],
        { concurrency: "unbounded" },
      );
      assert.equal(a.localPort, b.localPort);
      assert.notEqual(a.leaseId, b.leaseId);
      assert.equal(f.spawns(), 1);
      assert.include(
        f.commands.find((args) => args.includes("-N")) ?? [],
        "127.0.0.1:41773:localhost:5173",
      );
      yield* manager.releasePortForward(a.leaseId);
      yield* manager.releasePortForward(a.leaseId);
      assert.equal(f.kills(), 0);
      yield* manager.releasePortForward(b.leaseId);
      assert.equal(f.kills(), 1);
      const c = yield* manager.acquirePortForward(target, 5173);
      assert.equal(f.spawns(), 2);
      yield* manager.releasePortForward(c.leaseId);
      yield* manager.releasePortForward("unknown");
      assert.equal(f.kills(), 2);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect.each([
    { available: true, remotePort: 5173, localPort: 5173 },
    { available: false, remotePort: 5173, localPort: 41773 },
    { available: true, remotePort: 80, localPort: 41773 },
  ])(
    "prefers remote port $remotePort when available=$available, using local $localPort",
    ({ available, remotePort, localPort }) => {
      const f = fixture({ preferredAvailable: available });
      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const lease = yield* manager.acquirePortForward(target, remotePort);
        assert.equal(lease.localPort, localPort);
        assert.equal(f.spawns(), 1);
        assert.include(
          f.commands.find((args) => args.includes("-N")) ?? [],
          `127.0.0.1:${localPort}:localhost:${remotePort}`,
        );
        yield* manager.releasePortForward(lease.leaseId);
        assert.equal(f.kills(), 1);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    },
  );

  it.effect("falls back once if another listener takes the preferred port after the probe", () => {
    const f = fixture({ preferredAvailable: true, portInUseAfterProbe: 5173 });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const lease = yield* manager.acquirePortForward(target, 5173);
      assert.equal(lease.localPort, 41773);
      assert.equal(f.spawns(), 2);
      assert.equal(f.kills(), 1);
      const commands = f.commands.filter((args) => args.includes("-N"));
      assert.include(commands[0] ?? [], "127.0.0.1:5173:localhost:5173");
      assert.include(commands[1] ?? [], "127.0.0.1:41773:localhost:5173");
      yield* manager.releasePortForward(lease.leaseId);
      assert.equal(f.kills(), 2);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("keeps different remote ports independent", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const a = yield* manager.acquirePortForward(target, 5173);
      const b = yield* manager.acquirePortForward(target, 8080);
      assert.notEqual(a.localPort, b.localPort);
      yield* manager.releasePortForward(a.leaseId);
      assert.equal(f.kills(), 1);
      yield* manager.releasePortForward(b.leaseId);
      assert.equal(f.kills(), 2);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("serializes the last release against an in-flight reuse check", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let checks = 0;
      const f = fixture({
        running: Effect.suspend(() =>
          ++checks === 1
            ? Effect.succeed(true)
            : Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.as(true),
              ),
        ),
      });
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const a = yield* manager.acquirePortForward(target, 5173);
        const acquire = yield* Effect.forkChild(manager.acquirePortForward(target, 5173));
        yield* Deferred.await(entered);
        const release = yield* Effect.forkChild(manager.releasePortForward(a.leaseId));
        yield* Deferred.succeed(resume, undefined);
        const b = yield* Fiber.join(acquire);
        yield* Fiber.join(release);
        assert.equal(f.kills(), 0);
        yield* manager.releasePortForward(b.leaseId);
        assert.equal(f.kills(), 1);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("disconnect tears down acquired forwards and tolerates late releases", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const a = yield* manager.acquirePortForward(target, 5173);
      const b = yield* manager.acquirePortForward(target, 8080);
      yield* manager.disconnectEnvironment(target);
      assert.equal(f.kills(), 2);
      yield* manager.releasePortForward(a.leaseId);
      yield* manager.releasePortForward(b.leaseId);
      assert.equal(f.kills(), 2);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect.each(["disconnect", "scope close", "interrupt"] as const)(
    "%s cancels pending creation and closes its child",
    (action) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const f = fixture({
          stderr: Stream.fromEffect(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        });
        const scope = yield* Scope.make("sequential");
        const context = yield* Layer.buildWithScope(f.layer, scope);
        const manager = Context.get(context, SshTunnel.SshEnvironmentManager);
        const acquire = yield* Effect.forkChild(
          manager.acquirePortForward(target, 5173).pipe(Effect.provide(context)),
        );
        yield* Deferred.await(entered);
        if (action === "disconnect")
          yield* manager.disconnectEnvironment(target).pipe(Effect.provide(context));
        else if (action === "scope close") yield* Scope.close(scope, Exit.void);
        else yield* Fiber.interrupt(acquire);
        const exit = yield* Fiber.await(acquire);
        assert.isTrue(Exit.isFailure(exit));
        assert.equal(f.kills(), 1);
        yield* Scope.close(scope, Exit.void);
        assert.equal(f.kills(), 1);
      }),
  );

  it.effect("scope close interrupts creation before the spawner returns a child", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const f = fixture({
        spawnGate: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const scope = yield* Scope.make("sequential");
      const context = yield* Layer.buildWithScope(f.layer, scope);
      const manager = Context.get(context, SshTunnel.SshEnvironmentManager);
      const acquire = yield* Effect.forkChild(
        manager.acquirePortForward(target, 5173).pipe(Effect.provide(context)),
      );
      yield* Deferred.await(entered);
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(acquire)));
      assert.equal(f.kills(), 0);
    }),
  );

  it.effect("disconnect rejects acquires begun while remote stop is in flight", () =>
    Effect.gen(function* () {
      const stopping = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const f = fixture({
        stopGate: Deferred.succeed(stopping, undefined).pipe(
          Effect.andThen(Deferred.await(stopped)),
        ),
      });
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.acquirePortForward(target, 5173);
        const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
        yield* Deferred.await(stopping);
        const acquire = yield* Effect.forkChild(manager.acquirePortForward(target, 5173));
        const result = yield* Fiber.await(acquire);
        yield* Deferred.succeed(stopped, undefined);
        yield* Fiber.join(disconnect);
        assert.isTrue(Exit.isFailure(result));
        assert.equal(f.spawns(), 1);
        const fresh = yield* manager.acquirePortForward(target, 5173);
        yield* manager.releasePortForward(fresh.leaseId);
        assert.equal(f.kills(), 2);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("continues draining child stderr after returning a lease", () =>
    Effect.gen(function* () {
      const write = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();
      const f = fixture({
        stderr: Stream.make(bytes(ready)).pipe(
          Stream.concat(
            Stream.fromEffect(
              Deferred.await(write).pipe(
                Effect.andThen(Deferred.succeed(drained, undefined)),
                Effect.as(bytes("debug1: Connection established.\n")),
              ),
            ),
          ),
        ),
      });
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const lease = yield* manager.acquirePortForward(target, 5173);
        yield* Deferred.succeed(write, undefined);
        yield* Deferred.await(drained);
        yield* manager.releasePortForward(lease.leaseId);
        assert.equal(f.kills(), 1);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("replaces a dead child rather than returning a stale lease", () => {
    let running = true;
    const f = fixture({ running: Effect.sync(() => running) });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const old = yield* manager.acquirePortForward(target, 5173);
      running = false;
      // The second spawn resets its readiness check to a live process.
      // The old running check observes false, then the reserve call restores true.
      const net = yield* NetService.NetService;
      const replacement = yield* manager.acquirePortForward(target, 5173).pipe(
        Effect.provideService(NetService.NetService, {
          ...net,
          reserveLoopbackPort: () =>
            Effect.sync(() => {
              running = true;
              return 41774;
            }),
        }),
      );
      assert.notEqual(old.localPort, replacement.localPort);
      assert.equal(f.spawns(), 2);
      yield* manager.releasePortForward(old.leaseId);
      assert.equal(f.kills(), 1);
      yield* manager.releasePortForward(replacement.leaseId);
      assert.equal(f.kills(), 2);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("a foreign listener cannot prove readiness even after SSH's pre-bind log", () => {
    const f = fixture({
      stderr: Stream.make(
        bytes(
          "debug1: Local forwarding listening on 127.0.0.1 port 41773.\nbind [127.0.0.1]:41773: Address already in use\n",
        ),
      ),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
      running: Effect.succeed(false),
    });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const error = yield* manager.acquirePortForward(target, 5173).pipe(Effect.flip);
      assert.instanceOf(error, SshCommandError);
      assert.equal(f.kills(), 1);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("child exit fails immediately even while stderr remains open", () =>
    Effect.gen(function* () {
      const exitCode = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const drained = yield* Deferred.make<void>();
      const f = fixture({
        stderr: Stream.make(
          bytes("ssh: connect to host devbox port 22: Connection refused\n"),
        ).pipe(
          Stream.concat(
            Stream.fromEffect(
              Deferred.succeed(drained, undefined).pipe(Effect.andThen(Effect.never)),
            ),
          ),
        ),
        exitCode: Deferred.await(exitCode),
      });
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const acquire = yield* Effect.forkChild(
          manager.acquirePortForward(target, 5173).pipe(Effect.flip),
        );
        yield* Deferred.await(drained);
        yield* Deferred.succeed(exitCode, ChildProcessSpawner.ExitCode(255));
        const error = yield* Fiber.join(acquire);
        assert.instanceOf(error, SshCommandError);
        if (error instanceof SshCommandError) {
          assert.equal(error.exitCode, 255);
          assert.include(error.stderr, "Connection refused");
          assert.include(error.message, "Connection refused");
        }
        assert.equal(f.kills(), 1);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("readiness timeout includes a bounded tail of the last stderr lines", () =>
    Effect.gen(function* () {
      const drained = yield* Deferred.make<void>();
      const diagnostic =
        "FIRST-DIAGNOSTIC\n" +
        "x".repeat(20_000) +
        "\n" +
        Array.from(
          { length: 20 },
          (_, index) => `debug1: Waiting for authentication ${index}`,
        ).join("\n") +
        "\n";
      const f = fixture({
        stderr: Stream.make(bytes(diagnostic)).pipe(
          Stream.concat(
            Stream.fromEffect(
              Deferred.succeed(drained, undefined).pipe(Effect.andThen(Effect.never)),
            ),
          ),
        ),
      });
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const acquire = yield* Effect.forkChild(
          manager.acquirePortForward(target, 5173).pipe(Effect.flip),
        );
        yield* Deferred.await(drained);
        yield* TestClock.adjust(20_000);
        const error = yield* Fiber.join(acquire);
        assert.instanceOf(error, SshReadinessError);
        assert.include(error.message, "did not become ready");
        assert.include(error.message, "Waiting for authentication 19");
        assert.notInclude(error.message, "Waiting for authentication 11");
        assert.notInclude(error.message, "FIRST-DIAGNOSTIC");
        assert.isBelow(error.message.length, 16_500);
        assert.equal(f.kills(), 1);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("manager close rejects future acquisitions", () =>
    Effect.gen(function* () {
      const f = fixture();
      const scope = yield* Scope.make("sequential");
      const context = yield* Layer.buildWithScope(f.layer, scope);
      const manager = Context.get(context, SshTunnel.SshEnvironmentManager);
      const lease = yield* manager.acquirePortForward(target, 5173).pipe(Effect.provide(context));
      yield* Scope.close(scope, Exit.void);
      assert.equal(f.kills(), 1);
      const error = yield* manager
        .acquirePortForward(target, 5173)
        .pipe(Effect.provide(context), Effect.flip);
      assert.instanceOf(error, SshReadinessError);
      yield* manager.releasePortForward(lease.leaseId);
    }),
  );
});
