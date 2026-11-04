// Prints the PowerShell command lines ExternalLauncher spawns on win32 (reveal + browser).
// Usage: node driver.mjs <checkout>   (run from <checkout>/apps/server)
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

const checkout = process.argv[2];
const serverDir = nodePath.join(checkout, "apps/server");
const req = createRequire(nodePath.join(serverDir, "package.json"));
const load = (id) => import(pathToFileURL(req.resolve(id)).href);

const Effect = await load("effect/Effect");
const Layer = await load("effect/Layer");
const Stream = await load("effect/Stream");
const Sink = await load("effect/Sink");
const ConfigProvider = await load("effect/ConfigProvider");
const { ChildProcessSpawner } = await load("effect/process");
const NodeServices = await load("@effect/platform-node/NodeServices");
const sharedSrc = (name) =>
  import(pathToFileURL(nodePath.join(checkout, "packages/shared/src", name)).href);
const HostProcess = await sharedSrc("HostProcess.ts");
const { SpawnExecutableResolution } = await sharedSrc("shell.ts");
const ExternalLauncher = await import(
  pathToFileURL(nodePath.join(serverDir, "src/process/externalLauncher.ts")).href
);

// Stub executables so availability checks pass on Linux.
const binDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "t3-30954-bin-"));
const sysRoot = nodePath.join(binDir, "Windows");
// The launcher joins SYSTEMROOT with Windows separators; on Linux that is one literal file name.
const powershellPath = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
fs.mkdirSync(nodePath.dirname(powershellPath), { recursive: true });
for (const file of [powershellPath, nodePath.join(binDir, "explorer.EXE")]) {
  fs.writeFileSync(file, "");
  fs.chmodSync(file, 0o755);
}

const spawned = [];
const spawner = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      spawned.push(command);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  ),
);
const layer = Layer.mergeAll(
  ExternalLauncher.layer.pipe(Layer.provide(Layer.merge(NodeServices.layer, spawner))),
  Layer.succeed(HostProcess.Platform, "win32"),
  Layer.succeed(SpawnExecutableResolution, (command) => command),
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD", SYSTEMROOT: sysRoot },
    }),
  ),
);

const program = Effect.gen(function* () {
  const launcher = yield* ExternalLauncher.ExternalLauncher;
  yield* launcher.launchEditor({
    editor: "file-manager",
    reveal: true,
    cwd: "C:\\Users\\t3\\workspace\\docs\\report.pdf",
  });
  yield* launcher.launchBrowser("http://localhost:3773/pair#token=example");
});
await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));

for (const command of spawned) {
  const args = command.args.map(String);
  console.log(`spawn: ${command.command}`);
  console.log(`  args: ${JSON.stringify(args)}`);
  const encodedIndex = args.findIndex((arg) => arg.toLowerCase() === "-encodedcommand");
  if (encodedIndex >= 0) {
    console.log(
      `  decoded -EncodedCommand: ${Buffer.from(args[encodedIndex + 1], "base64").toString("utf16le")}`,
    );
  }
}
fs.rmSync(binDir, { recursive: true });
