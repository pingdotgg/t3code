// @effect-diagnostics nodeBuiltinImport:off -- Exercise real shells and OpenSSH with isolated fixtures.
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { SshCommandError } from "@t3tools/ssh/errors";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as NodeOS from "node:os";
import { vi } from "vite-plus/test";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

vi.mock("node:os", { spy: true });

const target = {
  alias: "managed-workspace",
  hostname: "helper-missing.invalid",
  username: null,
  port: null,
};

function runRecoveryScenario(
  operation:
    | "resolve"
    | "connect"
    | "disconnect"
    | "still-unavailable"
    | "fallback-shell"
    | "launchctl",
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-path-" });
    const bin = path.join(home, "bin");
    const helpers = path.join(home, "workspace tools");
    const probes = path.join(home, "probes");
    const ready = path.join(home, "ready");
    const proxyReached = path.join(home, "proxy-reached");
    const config = path.join(home, "ssh_config");
    yield* fs.makeDirectory(bin);
    yield* fs.makeDirectory(helpers);
    const inheritedPath = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
    const shellPath = `${helpers}:${inheritedPath}`;
    const preferredShell = path.join(bin, "preferred-shell");
    yield* fs.writeFileString(
      preferredShell,
      '#!/bin/sh\nexport T3_TEST_PREFERRED=1\nexec /bin/zsh "$@"\n',
    );
    yield* fs.chmod(preferredShell, 0o700);
    yield* fs.writeFileString(
      path.join(home, ".zshenv"),
      [
        "[[ -o login && -o interactive ]] || return 0",
        `print probe >> '${probes}'`,
        `if [[ ! -f '${ready}' ]]; then`,
        '  [[ "$T3_TEST_ALLOW_FALLBACK" = 1 && -z "$T3_TEST_PREFERRED" ]] || exit 1',
        "fi",
        "",
      ].join("\n"),
    );
    yield* fs.writeFileString(
      path.join(home, ".zprofile"),
      `if [[ -f '${ready}' ]]; then\nexport PATH='${shellPath}'\nelse\nexport PATH='${inheritedPath}'\nfi\n`,
    );
    yield* fs.writeFileString(
      path.join(bin, "ssh"),
      `#!/bin/sh\nexec /usr/bin/ssh -F '${config}' "$@"\n`,
    );
    yield* fs.chmod(path.join(bin, "ssh"), 0o700);
    yield* fs.writeFileString(path.join(helpers, "workspace-check"), "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(path.join(helpers, "workspace-check"), 0o700);
    yield* fs.writeFileString(
      path.join(helpers, "workspace-proxy"),
      `#!/bin/sh\nprintf 'proxy invoked %s\\n' "$1" > '${proxyReached}'\nexit 1\n`,
    );
    yield* fs.chmod(path.join(helpers, "workspace-proxy"), 0o700);
    yield* fs.writeFileString(
      config,
      [
        'Match originalhost managed-workspace exec "workspace-check"',
        "  HostName helper-ready.invalid",
        "Host managed-workspace",
        "  HostName helper-missing.invalid",
        "  ProxyCommand workspace-proxy %h",
        "  ControlMaster no",
        "  ControlPath none",
        "",
      ].join("\n"),
    );

    const layerEnvironment = DesktopEnvironment.layer({
      dirname: home,
      homeDirectory: home,
      platform: "darwin",
      processArch: yield* HostProcess.Architecture,
      appVersion: "0.1.0",
      appPath: home,
      isPackaged: true,
      resourcesPath: home,
      runningUnderArm64Translation: false,
    }).pipe(Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: home })));
    const layerShell = DesktopShellEnvironment.layer.pipe(Layer.provide(layerEnvironment));
    const layerSsh = DesktopSshEnvironment.layer({
      resolveCliRunner: Effect.succeed({ archiveVersion: "0.1.0" }),
    }).pipe(
      Layer.provideMerge(layerShell),
      Layer.provide(
        Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
          request: () => Effect.die("Unexpected authentication prompt"),
          resolve: () => Effect.die("Unexpected authentication response"),
        }),
      ),
    );
    const program = Effect.gen(function* () {
      const shell = yield* DesktopShellEnvironment.DesktopShellEnvironment;
      const ssh = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      assert.equal(yield* shell.installIntoProcess, false);
      if (operation !== "still-unavailable") yield* fs.writeFileString(ready, "");
      const initialProbes = operation === "fallback-shell" ? "probe\nprobe\n" : "probe\n";
      assert.equal(yield* shell.installIntoProcess, false);
      assert.equal((yield* ssh.resolveHost(target.alias)).hostname, "helper-missing.invalid");
      assert.equal(yield* fs.readFileString(probes), initialProbes);
      yield* TestClock.adjust("4999 millis");
      assert.equal((yield* ssh.resolveHost(target.alias)).hostname, "helper-missing.invalid");
      assert.equal(yield* fs.readFileString(probes), initialProbes);
      yield* TestClock.adjust("1 millis");
      if (operation === "resolve" || operation === "fallback-shell" || operation === "launchctl") {
        assert.equal((yield* ssh.resolveHost(target.alias)).hostname, "helper-ready.invalid");
        assert.equal((yield* ssh.resolveHost(target.alias)).hostname, "helper-ready.invalid");
      } else {
        if (operation === "disconnect") {
          assert.equal((yield* ssh.resolveHost(target.alias)).hostname, "helper-ready.invalid");
        }
        const result = yield* Effect.result(
          operation === "disconnect"
            ? ssh.disconnectEnvironment(target)
            : ssh.ensureEnvironment(target),
        );
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.instanceOf(result.failure, SshCommandError);
        if (operation === "connect" || operation === "disconnect") {
          assert.equal(
            yield* fs.readFileString(proxyReached),
            operation === "disconnect"
              ? "proxy invoked helper-missing.invalid\n"
              : "proxy invoked helper-ready.invalid\n",
          );
          assert.equal((yield* ssh.resolveHost(target.alias)).hostname, "helper-ready.invalid");
        } else {
          assert.equal(yield* fs.exists(proxyReached), false);
          if (result._tag === "Failure") {
            assert.include(result.failure.message, "workspace-proxy");
          }
          assert.equal((yield* ssh.resolveHost(target.alias)).hostname, "helper-missing.invalid");
        }
      }
      assert.equal(
        yield* fs.readFileString(probes),
        operation === "fallback-shell" ? "probe\nprobe\nprobe\n" : "probe\nprobe\n",
      );
      assert.equal(process.env.PATH, operation === "still-unavailable" ? inheritedPath : shellPath);
      yield* TestClock.adjust("1 hour");
      assert.equal(
        (yield* ssh.resolveHost(target.alias)).hostname,
        operation === "still-unavailable" ? "helper-missing.invalid" : "helper-ready.invalid",
      );
      assert.equal(
        yield* fs.readFileString(probes),
        operation === "still-unavailable" || operation === "fallback-shell"
          ? "probe\nprobe\nprobe\n"
          : "probe\nprobe\n",
      );
    }).pipe(
      Effect.provide(
        layerSsh.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeHttpClient.layerUndici, NetService.layer)),
        ),
      ),
    );

    const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawner = ChildProcessSpawner.make((command) =>
      nativeSpawner.spawn(
        operation === "launchctl" &&
          ChildProcess.isStandardCommand(command) &&
          command.command === "/bin/launchctl"
          ? ChildProcess.make("/bin/sh", ["-c", `printf '%s' '${inheritedPath}'`])
          : command,
      ),
    );
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env;
        process.env = {
          ...previous,
          HOME: home,
          ZDOTDIR: home,
          SHELL: operation === "fallback-shell" ? preferredShell : "/bin/zsh",
          T3_TEST_ALLOW_FALLBACK: operation === "fallback-shell" ? "1" : "0",
          PATH: inheritedPath,
        };
        const spy = vi.spyOn(NodeOS, "userInfo").mockReturnValue({
          ...NodeOS.userInfo(),
          shell: "/bin/zsh",
        });
        return { previous, spy };
      }),
      () => program.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      ({ previous, spy }) =>
        Effect.sync(() => {
          spy.mockRestore();
          process.env = previous;
        }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
}

describe("SSH shell PATH recovery with real OpenSSH", () => {
  it.effect.runIf(HostProcess.Platform.defaultValue() === "darwin")(
    "pins remote cleanup to the supplied host after PATH recovery changes alias resolution",
    () => runRecoveryScenario("disconnect"),
  );
  it.effect.runIf(HostProcess.Platform.defaultValue() === "darwin")(
    "retries the preferred shell when a fallback shell supplied only a degraded PATH",
    () => runRecoveryScenario("fallback-shell"),
  );
  it.effect.runIf(HostProcess.Platform.defaultValue() === "darwin")(
    "retries the login shell when launchctl supplied only a degraded PATH",
    () => runRecoveryScenario("launchctl"),
  );
  it.effect.runIf(HostProcess.Platform.defaultValue() === "darwin")(
    "recovers a failed startup capture before resolving a host and caches the recovered PATH",
    () => runRecoveryScenario("resolve"),
  );
  it.effect.runIf(HostProcess.Platform.defaultValue() === "darwin")(
    "recovers a failed startup capture before invoking a saved host's ProxyCommand",
    () => runRecoveryScenario("connect"),
  );
  it.effect.runIf(HostProcess.Platform.defaultValue() === "darwin")(
    "preserves the SSH error when PATH capture is still unavailable",
    () => runRecoveryScenario("still-unavailable"),
  );
});
