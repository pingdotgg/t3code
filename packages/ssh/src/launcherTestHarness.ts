// @effect-diagnostics nodeBuiltinImport:off - Executes the generated remote launcher in an isolated shell with fake commands and clock.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { launchOrReuseRemoteServer, type RemoteT3RunnerOptions } from "./tunnel.ts";

// Capture exactly the script sent over SSH, then run it with fake remote commands.
export const captureLauncherFor = Effect.fn("test.captureLauncher")(function* (
  runner: RemoteT3RunnerOptions,
) {
  let script = "";
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag === "StandardCommand") {
        const stdin = command.options.stdin;
        if (typeof stdin === "object" && "stream" in stdin && Stream.isStream(stdin.stream)) {
          script = yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString);
        }
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        stdout: Stream.make(new TextEncoder().encode('{"remotePort":3773}\n')),
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  yield* launchOrReuseRemoteServer(
    { alias: "test", hostname: "test.invalid", username: null, port: null },
    undefined,
    runner,
  ).pipe(
    Effect.provide(
      Layer.merge(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
  );
  return script;
});

export const captureLauncher = captureLauncherFor({ nodeScriptPath: "/fake/server.ts" });

export function runLauncher(
  script: string,
  options: {
    readonly marker?: unknown;
    readonly archive?: boolean;
    readonly clearMarkerOnReady?: boolean;
    readonly recordedKind?: "managed" | "external";
    readonly clockJump?: number;
    readonly readyAt?: number;
    readonly initialPort?: number;
    // The desktop publishes runtime and removes the marker right after the first runtime read.
    readonly publishAfterFirstRuntimeRead?: boolean;
  },
) {
  const root = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
  const home = NodeFS.mkdtempSync(NodePath.join(root, "packages/ssh/.ssh-launcher-test-"));
  try {
    const bin = NodePath.join(home, "bin");
    const runtime = NodePath.join(home, ".t3/runtime");
    NodeFS.mkdirSync(bin);
    NodeFS.mkdirSync(runtime, { recursive: true });
    const markerPath = NodePath.join(runtime, "desktop-update-in-progress");
    if (options.marker)
      NodeFS.writeFileSync(
        markerPath,
        typeof options.marker === "string" ? options.marker : JSON.stringify(options.marker),
      );
    NodeFS.writeFileSync(NodePath.join(home, "clock"), "0");
    NodeFS.writeFileSync(NodePath.join(home, "events"), "");
    const executable = (name: string, body: string) =>
      NodeFS.writeFileSync(NodePath.join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, {
        mode: 0o755,
      });
    NodeFS.writeFileSync(
      NodePath.join(home, "clock.cjs"),
      `
const fs = require('node:fs');
Date.now = () => Number(fs.readFileSync(process.env.HOME + '/clock', 'utf8'));
`,
    );
    executable(
      options.archive ? "test-node" : "node",
      `
case "\${2:-}" in
  */server-runtime.json)
    NOW="$(cat "$HOME/clock")"
    printf 'runtime %s\\n' "$NOW" >> "$HOME/events"
    if [ "$NOW" -ge "$TEST_READY_AT" ] || [ -e "$2" ]; then printf '%s %s' "$TEST_SERVER_PID" 4888
    elif [ "$TEST_PUBLISH_AFTER_FIRST_READ" = 1 ]; then
      mkdir -p "\${2%/*}"
      printf '{}' > "$2"
      rm -f "$HOME/.t3/runtime/desktop-update-in-progress"
      exit 1
    elif [ -n "$TEST_INITIAL_PORT" ]; then printf '%s %s' "$TEST_SERVER_PID" "$TEST_INITIAL_PORT"
    else exit 1; fi ;;
  */port)
    printf 'start %s\\n' "$(cat "$HOME/clock")" >> "$HOME/events"
    printf 5999 ;;
  [0-9]*)
    NOW="$(cat "$HOME/clock")"
    printf 'probe %s %s\\n' "$2" "$NOW" >> "$HOME/events"
    [ "$2" = 5999 ] || { [ "$2" = 4888 ] && { [ "$NOW" -ge "$TEST_READY_AT" ] || [ -e "$HOME/.t3/userdata/server-runtime.json" ]; }; } ;;
  */desktop-update-in-progress)
    printf 'marker %s\\n' "$(cat "$HOME/clock")" >> "$HOME/events"
    exec "$TEST_REAL_NODE" --require "$HOME/clock.cjs" "$@" ;;
  *) exec "$TEST_REAL_NODE" --require "$HOME/clock.cjs" "$@" ;;
esac`,
    );
    executable(
      "sleep",
      `awk -v seconds="$1" '{ printf "%.0f", $1 + seconds * 1000 }' "$HOME/clock" > "$HOME/clock.next"
mv "$HOME/clock.next" "$HOME/clock"
if [ "$TEST_CLEAR_MARKER" = 1 ] && [ "$(cat "$HOME/clock")" -ge "$TEST_READY_AT" ]; then
  rm -f "$HOME/.t3/runtime/desktop-update-in-progress"
fi
if [ -n "$TEST_CLOCK_JUMP" ] && [ ! -e "$HOME/jumped" ]; then
  printf '%s' "$TEST_CLOCK_JUMP" > "$HOME/clock"
  touch "$HOME/jumped"
fi`,
    );
    executable("nohup", ":");
    if (options.recordedKind) {
      const state = NodePath.join(home, ".t3/ssh-launch/test-target");
      NodeFS.mkdirSync(state, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(state, "pid"), String(process.pid));
      NodeFS.writeFileSync(NodePath.join(state, "port"), "5999");
      NodeFS.writeFileSync(NodePath.join(state, "managed"), options.recordedKind);
      const runner = script.split("cat >\"$RUNNER_NEXT\" <<'SH'\n")[1]?.split("\nSH\n")[0];
      if (!runner) throw new Error("runner missing");
      NodeFS.writeFileSync(NodePath.join(state, "run-t3.sh"), runner + "\n");
    }
    if (options.archive) {
      executable("node", 'printf "unexpected host node invocation\\n" >&2; exit 1');
      const version = NodePath.join(home, ".t3/runtime/versions/1.2.3");
      NodeFS.mkdirSync(version, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(version, ".install-complete"), "1.2.3");
      NodeFS.writeFileSync(
        NodePath.join(home, "helper.ts"),
        `
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command } from "effect/cli";
import { sshHelperCommand } from ${JSON.stringify(NodePath.join(root, "apps/server/src/cli/sshHelper.ts"))};
await Effect.runPromise(Command.runWith(sshHelperCommand, { version: "1.2.3" })(process.argv.slice(2)).pipe(Effect.provide(NodeServices.layer)));
`,
      );
      NodeFS.writeFileSync(
        NodePath.join(version, "t3"),
        `#!/bin/sh
set -eu
if [ "$1" = --version ]; then printf 1.2.3; exit; fi
[ "$1" = __ssh-helper ]
case "$2" in
  update-remaining) printf 'marker %s\\n' "$(cat "$HOME/clock")" >> "$HOME/events"; exec "$TEST_REAL_NODE" --require "$HOME/clock.cjs" "$HOME/helper.ts" "$2" "$3" ;;
  runtime-port | pick-port | wait-ready) exec "$HOME/bin/test-node" - "$3" ;;
  *) exit 1 ;;
esac
`,
        { mode: 0o755 },
      );
    }
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-s", "--", "test-target"], {
      input: `kill() {
  if [ "$1" = -0 ]; then command kill "$@"; else
    printf 'kill %s\\n' "$*" >> "$HOME/events"
    return 1
  fi
}
${script}`,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        TEST_REAL_NODE: process.execPath,
        TEST_CLEAR_MARKER: options.clearMarkerOnReady ? "1" : "0",
        TEST_CLOCK_JUMP: options.clockJump === undefined ? "" : String(options.clockJump),
        TEST_SERVER_PID: String(process.pid),
        TEST_READY_AT: String(options.readyAt ?? 1_000_000),
        TEST_INITIAL_PORT: options.initialPort === undefined ? "" : String(options.initialPort),
        TEST_PUBLISH_AFTER_FIRST_READ: options.publishAfterFirstRuntimeRead ? "1" : "0",
      },
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `launcher failed: ${result.error ?? result.status}\n${result.stderr}\n${result.stdout}\n${NodeFS.readFileSync(NodePath.join(home, "events"), "utf8")}`,
      );
    return {
      output: JSON.parse(result.stdout.trim()),
      events: NodeFS.readFileSync(NodePath.join(home, "events"), "utf8").trim().split("\n"),
      now: Number(NodeFS.readFileSync(NodePath.join(home, "clock"), "utf8")),
      markerExists: NodeFS.existsSync(markerPath),
    };
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
}
