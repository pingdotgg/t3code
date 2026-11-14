#!/usr/bin/env node
// The app command of e2e.config.ts: starts the dev stack of the checkout it runs in on a fresh
// T3 home. e2e stops it with a signal, which ends the scope and the processes it started.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ScenarioError } from "./shell.ts";

// The dev runner's web port is 5733 plus an offset. Mirror of BASE_WEB_PORT in dev-runner.ts.
const BASE_WEB_PORT = 5733;
// The replay agent `vp run dev` registers: free, recorded turns through the real adapter.
const REPLAY = { instanceId: "devReplay", model: "showcase" };
// Generated text (titles) cannot go to the replay agent: the server swaps an ACP agent for the
// first enabled real provider, else its default, Codex. So every provider it could fall back to
// is off and Codex is a command that only fails: no run reaches a paid model.
// Mirror of TEXT_GENERATION_FALLBACK_DRIVERS in shared/serverSettings.
const REAL_PROVIDERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "muse",
  "pi",
  "opencode",
  "antigravity",
];

// The server labels its environment with the host's name, probed through these commands.
// Captures must not depend on, or show, the machine that made them.
const HOST_LABEL_SHIM = `#!/bin/sh
case "$*" in
  "--pretty" | "--get ComputerName") echo "Scenario" ;;
  *) for real in /usr/bin /usr/sbin /bin; do
       [ -x "$real/$(basename "$0")" ] && exec "$real/$(basename "$0")" "$@"
     done
     exit 127 ;;
esac
`;

const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const prepareHome = Effect.fn("startApp.prepareHome")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(home, { recursive: true, force: true });
  yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
  yield* fs.makeDirectory(path.join(home, "bin"));
  for (const command of ["hostnamectl", "scutil"]) {
    const shim = path.join(home, "bin", command);
    yield* fs.writeFileString(shim, HOST_LABEL_SHIM);
    yield* fs.chmod(shim, 0o755);
  }
  const noModel = path.join(home, "bin/no-model");
  yield* fs.writeFileString(noModel, "#!/bin/sh\necho 'scenarios run no model' >&2\nexit 1\n");
  yield* fs.chmod(noModel, 0o755);
  yield* fs.writeFileString(
    path.join(home, "userdata/settings.json"),
    yield* encodeSettings({
      defaultModelSelection: REPLAY,
      providerInstances: Object.fromEntries(
        REAL_PROVIDERS.map((driver) => [
          driver,
          {
            driver,
            enabled: false,
            ...(driver === "codex" ? { config: { binaryPath: noModel } } : {}),
          },
        ]),
      ),
    }),
  );
});

/** Starts a process in the caller's scope and hands each line it prints to `onLine`. */
const start = Effect.fn("startApp.start")(function* (input: {
  readonly cwd: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly onLine: (line: string) => Effect.Effect<void, never, FileSystem.FileSystem>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      extendEnv: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
      forceKillAfter: "5 seconds",
    }),
  );
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(input.onLine),
    Effect.ignore,
    Effect.forkScoped,
  );
  return child;
});

const startApp = Effect.fn("startApp")(function* (input: {
  readonly surface: "web" | "mobile";
  readonly home: string;
  readonly ports: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const net = yield* NetService.NetService;
  const node = yield* HostProcess.ExecutablePath;
  const checkout = yield* HostProcess.WorkingDirectory;
  const hostEnvironment = yield* HostProcess.Environment;
  yield* prepareHome(input.home);
  const env = {
    ...hostEnvironment,
    PATH: `${path.join(input.home, "bin")}:${hostEnvironment.PATH ?? ""}`,
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
  };
  const devRunner = (mode: string, args: ReadonlyArray<string>) => [
    "scripts/dev-runner.ts",
    mode,
    "--home-dir",
    input.home,
    "--no-seed",
    ...args,
  ];

  if (input.surface === "web") {
    // e2e opens the app at this host, so the web server is told to bind exactly it. Left to its
    // default, `localhost`, it binds ::1 alone on machines that resolve the name to IPv6 first.
    const [host = "", webPort = ""] = input.ports;
    const origin = `http://${host}:${webPort}`;
    const serverPort = String(yield* net.reserveLoopbackPort());
    const token = yield* (yield* SecureRandom.SecureRandom).uuidV4();
    const ports = ["--port", serverPort, "--dev-url", origin];
    const webEnv = { ...env, T3CODE_PORT_OFFSET: String(Number(webPort) - BASE_WEB_PORT) };
    const server = yield* start({
      cwd: checkout,
      command: node,
      args: devRunner("dev:server", ports),
      env: {
        ...webEnv,
        T3CODE_DEV_ALLOWED_ORIGINS: origin,
        // Makes the startup pairing link reusable, so every test can sign in with it.
        T3CODE_DEV_AUTH_TOKEN: `${token}${token}`.replaceAll("-", ""),
      },
      onLine: (line) => {
        const url = /pairingUrl:\s*(\S+)/.exec(line)?.[1];
        if (url === undefined) return Console.log(line);
        // The link is a credential: it goes to a file the tests read, never to the log.
        const { pathname, search, hash } = new URL(url);
        return fs
          .writeFileString(path.join(input.home, "pairing-path"), `${pathname}${search}${hash}`)
          .pipe(Effect.ignore);
      },
    });
    const web = yield* start({
      cwd: checkout,
      command: node,
      args: devRunner("dev:web", [...ports, "--", "--host", host]),
      env: webEnv,
      onLine: Console.log,
    });
    // A web server that came up on another loopback address would leave e2e waiting out its
    // whole startup timeout; say so at once instead.
    const boundElsewhere = Effect.gen(function* () {
      const elsewhere = host === "::1" ? "127.0.0.1" : "::1";
      if (yield* net.hasListenerOnHost(Number(webPort), host)) return yield* Effect.never;
      if (!(yield* net.hasListenerOnHost(Number(webPort), elsewhere))) {
        return yield* new ScenarioError({ message: "The web server is not listening yet." });
      }
      yield* Console.error(
        `The web server listens on ${elsewhere}:${webPort}, not on ${host}: it ignored --host.`,
      );
      return 1;
    }).pipe(
      Effect.retry({
        schedule: Schedule.spaced("1 second"),
        while: (error) => error._tag === "ScenarioError",
      }),
    );
    return yield* Effect.raceAll([server.exitCode, web.exitCode, boundElsewhere]);
  }

  // The device is another machine: the server listens on every interface, and Metro serves the
  // dev client its JavaScript. Tests mint their own pairing links, so the startup one is dropped.
  const [serverPort = "", metroPort = "", host = ""] = input.ports;
  const server = yield* start({
    cwd: checkout,
    command: node,
    args: devRunner("dev:server", ["--host", "0.0.0.0", "--port", serverPort]),
    env,
    onLine: (line) => (line.includes("pairingUrl:") ? Effect.void : Console.log(line)),
  });
  yield* net.hasListenerOnHost(Number(serverPort), "127.0.0.1").pipe(
    Effect.filterOrFail(
      (listening) => listening,
      () => new ScenarioError({ message: "The server is not listening yet." }),
    ),
    Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 600 }),
  );
  const metro = yield* start({
    cwd: path.join(checkout, "apps/mobile"),
    command: "npx",
    args: ["expo", "start", "--dev-client", "--scheme", "t3code-dev", "--lan", "--port", metroPort],
    env: {
      ...env,
      APP_VARIANT: "development",
      CI: "1",
      // Lazily fetched chunks sometimes arrive broken on pool devices.
      EXPO_NO_METRO_LAZY: "1",
      REACT_NATIVE_PACKAGER_HOSTNAME: host,
    },
    onLine: Console.log,
  });
  return yield* Effect.raceFirst(server.exitCode, metro.exitCode);
});

const command = Command.make(
  "start-app",
  {
    surface: Argument.Literals("surface", ["web", "mobile"]).pipe(
      Argument.withDescription(
        "web: server and Vite. mobile: server on every interface and Metro.",
      ),
    ),
    home: Argument.String("t3-home").pipe(Argument.withDescription("T3 home to recreate.")),
    ports: Argument.String("port").pipe(
      Argument.withDescription(
        "web: <host> <web-port>. mobile: <server-port> <metro-port> <host>.",
      ),
      Argument.variadic(),
    ),
  },
  (input) =>
    startApp(input).pipe(
      Effect.flatMap((exitCode) =>
        Effect.sync(() => {
          process.exitCode = Number(exitCode) || 1;
        }),
      ),
    ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide([NodeServices.layer, NodeCrypto.layer, NetService.layer]),
    NodeRuntime.runMain,
  );
}
