// @effect-diagnostics nodeBuiltinImport:off - hashes the pinned upstream archive before extraction.
import * as NodeCrypto from "node:crypto";
import { SpeechSynthesisError, type PiperRuntimeStatus } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { readBoundedSpeechBody } from "./httpBody.ts";
import { PIPER_VERSION, piperArtifact } from "./piperArtifacts.ts";

export class PiperRuntime extends Context.Service<
  PiperRuntime,
  {
    readonly status: Effect.Effect<PiperRuntimeStatus>;
    readonly executable: Effect.Effect<string, SpeechSynthesisError>;
    readonly install: Effect.Effect<PiperRuntimeStatus, SpeechSynthesisError>;
    readonly cancel: Effect.Effect<PiperRuntimeStatus>;
    readonly remove: Effect.Effect<PiperRuntimeStatus, SpeechSynthesisError>;
  }
>()("t3/speech/PiperRuntime") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const process = yield* ProcessRunner.ProcessRunner;
  const http = yield* HttpClient.HttpClient;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const libc = platform === "linux" ? yield* HostProcess.LinuxLibc : undefined;
  const artifact = piperArtifact(platform, arch, libc);
  const platformKey = `${platform}-${arch}`;
  const root = path.join(config.stateDir, "speech", "runtime");
  const directory = path.join(root, `piper-${PIPER_VERSION}-${platformKey}`);
  const binary = path.join(directory, platform === "win32" ? "python.exe" : "bin/python3");
  const isInstalled = fs.exists(binary).pipe(Effect.orElseSucceed(() => false));
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  let installing: Fiber.Fiber<void, SpeechSynthesisError> | undefined;
  const status = Effect.gen(function* () {
    return {
      platform: platformKey,
      state: !artifact
        ? ("unsupported" as const)
        : installing
          ? ("installing" as const)
          : (yield* isInstalled)
            ? ("ready" as const)
            : ("not-installed" as const),
      ...(!artifact
        ? {
            reason: `No managed Piper runtime is available for ${platformKey}${libc === "musl" ? " (musl)" : ""}. Choose another environment or a cloud provider.`,
          }
        : {}),
    };
  });
  const executable = Effect.gen(function* () {
    if (!artifact || !(yield* isInstalled))
      return yield* new SpeechSynthesisError({ reason: "not-configured" });
    return binary;
  });
  const installWork = Effect.gen(function* () {
    if (!artifact) return yield* new SpeechSynthesisError({ reason: "unavailable" });
    if (yield* isInstalled) return;
    yield* fs.makeDirectory(root, { recursive: true });
    const staging = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: ".install-" });
    const response = yield* http.get(artifact.url);
    if (response.status !== 200) return yield* new SpeechSynthesisError({ reason: "unavailable" });
    const bytes = yield* readBoundedSpeechBody(response, artifact.size);
    if (
      bytes.length !== artifact.size ||
      NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
    )
      return yield* new SpeechSynthesisError({ reason: "invalid-audio" });
    const archive = path.join(staging, artifact.filename);
    yield* fs.writeFile(archive, bytes);
    const extraction = yield* process.run({
      command: "tar",
      args: ["-xf", archive, "-C", staging],
      timeout: "1 minute",
    });
    if (extraction.code !== 0) return yield* new SpeechSynthesisError({ reason: "unavailable" });
    const unpacked = path.join(staging, "python");
    const executable = path.join(unpacked, platform === "win32" ? "python.exe" : "bin/python3");
    if (platform !== "win32") yield* fs.chmod(executable, 0o755);
    const packages = yield* process.run({
      command: executable,
      args: [
        "-I",
        "-m",
        "pip",
        "--isolated",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--no-cache-dir",
        "--only-binary=:all:",
        "--index-url",
        "https://pypi.org/simple",
        `${artifact.wheelUrl}#sha256=${artifact.wheelSha256}`,
        "onnxruntime==1.20.1",
        "numpy==2.2.6",
        "pathvalidate==3.3.1",
      ],
      cwd: unpacked,
      timeout: "5 minutes",
      maxOutputBytes: 1024 * 1024,
    });
    if (packages.code !== 0) return yield* new SpeechSynthesisError({ reason: "unavailable" });
    const probe = yield* process.run({
      command: executable,
      args: ["-I", "-c", "from piper import PiperVoice; import onnxruntime"],
      cwd: unpacked,
      timeout: "10 seconds",
    });
    if (probe.code !== 0) return yield* new SpeechSynthesisError({ reason: "unavailable" });
    yield* fs.remove(directory, { recursive: true, force: true });
    yield* fs.rename(unpacked, directory);
  }).pipe(
    Effect.scoped,
    Effect.timeout("10 minutes"),
    Effect.mapError(() => new SpeechSynthesisError({ reason: "unavailable" })),
  );
  const start = Effect.fn("PiperRuntime.startInstall")(
    function* () {
      if (installing) return installing;
      const fiber = yield* installWork.pipe(Effect.forkIn(scope));
      installing = fiber;
      fiber.addObserver(() => {
        if (installing === fiber) installing = undefined;
      });
      return fiber;
    },
    Effect.uninterruptible,
    lock.withPermits(1),
  );
  const install = Effect.gen(function* () {
    const fiber = yield* start();
    const exit = yield* Fiber.await(fiber);
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
      return yield* Effect.failCause(exit.cause);
    return yield* status;
  });
  const cancel = Effect.gen(function* () {
    if (installing) yield* Fiber.interrupt(installing);
    return yield* status;
  });
  const remove = Effect.gen(function* () {
    if (installing) return yield* new SpeechSynthesisError({ reason: "busy" });
    yield* fs
      .remove(directory, { recursive: true, force: true })
      .pipe(Effect.mapError(() => new SpeechSynthesisError({ reason: "unavailable" })));
    return yield* status;
  }).pipe(lock.withPermits(1));
  return PiperRuntime.of({ status, executable, install, cancel, remove });
});
export const layer = Layer.effect(PiperRuntime, make);
