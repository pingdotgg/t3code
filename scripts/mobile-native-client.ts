import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export type NativePlatform = "ios" | "android";
const NativeClientRecord = Schema.Struct({ fingerprint: Schema.String, binary: Schema.String });
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(NativeClientRecord));
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeClientRecord));
const encodeOutput = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isNotLink = Schema.is(Schema.Struct({ code: Schema.Literal("EINVAL") }));
const decodeSimulators = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      devices: Schema.Record(
        Schema.String,
        Schema.Array(Schema.Struct({ udid: Schema.String, state: Schema.String })),
      ),
    }),
  ),
);
export type NativeClientRecord = typeof NativeClientRecord.Type;
export type NativeClientStatus = "compatible" | "missing" | "unknown" | "stale";
export class NativeClientError extends Schema.TaggedError<NativeClientError>()(
  "NativeClientError",
  { message: Schema.String },
) {}

export function clientStatus(
  fingerprint: string,
  binary: string | null,
  record: NativeClientRecord | null,
): NativeClientStatus {
  if (binary === null) return "missing";
  if (!record || record.binary !== binary) return "unknown";
  return record.fingerprint === fingerprint ? "compatible" : "stale";
}

/** Record only a successful installation built from unchanged native inputs. */
export const ensureClient = Effect.fn("ensureClient")(function* <E, R, E2, R2>(operations: {
  fingerprint: Effect.Effect<string, E, R>;
  installedBinary: Effect.Effect<string | null, E, R>;
  readRecord: Effect.Effect<NativeClientRecord | null, E, R>;
  build: Effect.Effect<void, E, R>;
  saveRecord: (record: NativeClientRecord) => Effect.Effect<void, E2, R2>;
}) {
  const fingerprint = yield* operations.fingerprint;
  const status = clientStatus(
    fingerprint,
    yield* operations.installedBinary,
    yield* operations.readRecord,
  );
  if (status === "compatible") return { status, rebuilt: false, fingerprint };
  yield* operations.build;
  if ((yield* operations.fingerprint) !== fingerprint) {
    return yield* new NativeClientError({
      message:
        "Native inputs changed during the build. Run ensure again; this build was not recorded.",
    });
  }
  const binary = yield* operations.installedBinary;
  if (binary === null)
    return yield* new NativeClientError({
      message: "Build finished but the development client is not installed.",
    });
  yield* operations.saveRecord({ fingerprint, binary });
  return { status: "compatible" as const, rebuilt: true, fingerprint };
});

const digest = Effect.fn("nativeClient.digest")(function* (value: string | Uint8Array) {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.digest(
    "SHA-256",
    typeof value === "string" ? new TextEncoder().encode(value) : value,
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

/** Hash fixed-size chunks to bound memory, including resources and symlink targets. */
export const hashBundle = Effect.fn("hashBundle")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries: string[] = [];
  const visit = (
    relative: string,
  ): Effect.Effect<void, FileSystemError, FileSystem.FileSystem | Crypto.Crypto> =>
    Effect.gen(function* () {
      const names = (yield* fs.readDirectory(path.join(root, relative))).sort((a, b) =>
        a.localeCompare(b, "en"),
      );
      for (const name of names) {
        const key = path.join(relative, name);
        const absolute = path.join(root, key);
        // FileSystem.stat follows links; readLink distinguishes them without following a cycle.
        const link = yield* fs.readLink(absolute).pipe(
          Effect.catchIf(
            (error) => isNotLink(error.reason.cause),
            () => Effect.succeed(null),
          ),
        );
        if (link !== null) {
          entries.push(`link:${key}:${link}`);
          continue;
        }
        const info = yield* fs.stat(absolute);
        if (info.type === "Directory") {
          entries.push(`directory:${key}`);
          yield* visit(key);
        } else {
          const chunks = yield* fs.stream(absolute, { chunkSize: FileSystem.Size(65536) }).pipe(
            Stream.mapEffect((chunk) => digest(chunk)),
            Stream.runCollect,
          );
          entries.push(`file:${key}:${yield* digest(chunks.join("\n"))}`);
        }
      }
    });
  yield* visit("");
  return yield* digest(entries.map((entry) => `${entry.length}:${entry}`).join(""));
});
type FileSystemError = import("effect/PlatformError").PlatformError;

const bundleId = "com.t3tools.t3code.dev";
const roots = Effect.gen(function* () {
  const path = yield* Path.Path;
  const repo = yield* path.fromFileUrl(new URL("../", import.meta.url));
  return { repo, mobile: path.join(repo, "apps/mobile") };
});
const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (a, b) => a + b,
    ),
  );
const command = Effect.fn("nativeClient.command")(function* (
  program: string,
  args: string[],
  inherit = false,
  cwd?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcessEnvironment;
  const child = yield* spawner.spawn(
    ChildProcess.make(program, args, {
      cwd: cwd ?? (yield* roots).mobile,
      env: {
        ...environment,
        APP_VARIANT: "development",
        MOBILE_VERSION_POLICY: "appVersion",
        T3CODE_IOS_PERSONAL_TEAM: "0",
        CI: "1",
        EXPO_NO_GIT_STATUS: "1",
      },
      stdin: "ignore",
      stdout: inherit ? "inherit" : "pipe",
      stderr: inherit ? "inherit" : "pipe",
    }),
  );
  const [stdout, stderr, code] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode],
    { concurrency: "unbounded" },
  );
  if (code !== 0)
    return yield* new NativeClientError({
      message: `${program} ${args[0]} failed (${code}): ${stderr || "see build output"}`,
    });
  return stdout.trim();
}, Effect.scoped);

const fingerprint = Effect.fn("nativeClient.fingerprint")(function* (platform: NativePlatform) {
  const output = yield* command(yield* HostProcessExecutablePath, [
    "--eval",
    `require('expo/fingerprint').createFingerprintAsync(process.cwd(), { platforms: [process.argv[1]], silent: true }).then(fp => console.log('T3_NATIVE_FINGERPRINT=' + fp.hash)).catch(e => { console.error(e); process.exitCode = 1; });`,
    platform,
  ]);
  const hash = output
    .split("\n")
    .find((line) => line.startsWith("T3_NATIVE_FINGERPRINT="))
    ?.split("=")[1];
  if (!hash || !/^[a-f0-9]{40,64}$/.test(hash))
    return yield* new NativeClientError({ message: "Expo did not return a native fingerprint." });
  return hash;
});

const validateDevice = Effect.fn("nativeClient.validateDevice")(function* (
  platform: NativePlatform,
  device: string,
) {
  if (platform === "ios") {
    if ((yield* HostProcessPlatform) !== "darwin")
      return yield* new NativeClientError({
        message: "Run iOS check/ensure on the Mac that hosts the simulator.",
      });
    const listing = yield* decodeSimulators(
      yield* command("xcrun", ["simctl", "list", "devices", "available", "--json"]),
    );
    const simulator = Object.values(listing.devices)
      .flat()
      .find((entry) => entry.udid === device);
    if (!simulator)
      return yield* new NativeClientError({
        message: `No available iOS simulator with UDID ${device}.`,
      });
    if (simulator.state !== "Booted")
      return yield* new NativeClientError({
        message: `Boot the selected simulator first: xcrun simctl boot ${device}`,
      });
  } else {
    if ((yield* command("adb", ["-s", device, "get-state"])) !== "device")
      return yield* new NativeClientError({ message: "Android device is not connected." });
    if ((yield* command("adb", ["-s", device, "shell", "getprop", "ro.kernel.qemu"])) !== "1")
      return yield* new NativeClientError({
        message: "Select an Android emulator, not a physical device.",
      });
  }
});

export const installedBinary = Effect.fn("installedBinary")(function* (
  platform: NativePlatform,
  device: string,
  run: typeof command = command,
) {
  if (platform === "ios") {
    const apps = yield* run("xcrun", ["simctl", "listapps", device]);
    if (!apps.includes(`"${bundleId}"`)) return null;
    return yield* hashBundle(
      yield* run("xcrun", ["simctl", "get_app_container", device, bundleId, "app"]),
    );
  }
  const installed = yield* run("adb", ["-s", device, "shell", "pm", "list", "packages", bundleId]);
  if (!installed.split("\n").some((line) => line.trim() === `package:${bundleId}`)) return null;
  const packages = yield* run("adb", ["-s", device, "shell", "pm", "path", bundleId]);
  const apks = packages
    .split("\n")
    .filter((line) => line.startsWith("package:"))
    .map((line) => line.slice(8).trim())
    .sort();
  if (apks.length === 0) return null;
  const hashes = yield* Effect.forEach(apks, (apk) =>
    Effect.gen(function* () {
      if (!/^\/[\w/+=.~-]+\.apk$/.test(apk))
        return yield* new NativeClientError({ message: "Unexpected installed APK path." });
      const hash = (yield* run("adb", ["-s", device, "shell", "sha256sum", apk])).split(/\s/)[0];
      if (!hash || !/^[a-f0-9]{64}$/.test(hash))
        return yield* new NativeClientError({ message: "Could not hash installed APK." });
      return hash;
    }),
  );
  return yield* digest(hashes.sort().join("\n"));
});

const main = Command.make(
  "mobile-native-client",
  {
    mode: Argument.choice("mode", ["check", "ensure"]),
    platform: Argument.choice("platform", ["ios", "android"]),
    device: Argument.string("device"),
  },
  Effect.fn("nativeClient.main")(function* ({ mode, platform, device }) {
    yield* validateDevice(platform, device);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* HostProcessEnvironment;
    const home = environment.HOME ?? environment.USERPROFILE;
    if (!home)
      return yield* new NativeClientError({
        message: "HOME or USERPROFILE must be set to store native client records.",
      });
    const recordPath = path.join(
      home,
      ".cache/t3code/native-clients",
      platform,
      `${yield* digest(device)}.json`,
    );
    const operations = {
      fingerprint: fingerprint(platform),
      installedBinary: installedBinary(platform, device),
      readRecord: fs.readFileString(recordPath).pipe(
        Effect.flatMap(decodeRecord),
        Effect.catchTag("SchemaError", () => Effect.succeed(null)),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      ),
      build: Effect.gen(function* () {
        yield* Console.error(
          "Native client is missing, stale, or unverified. Building and installing a development client...",
        );
        const tracked = yield* command(
          "git",
          ["ls-files", `apps/mobile/${platform}`],
          false,
          (yield* roots).repo,
        );
        if (tracked)
          return yield* new NativeClientError({
            message:
              "Native directory contains tracked files; clean prebuild would overwrite them.",
          });
        yield* command(
          "vp",
          ["exec", "expo", "prebuild", "--clean", "--platform", platform, "--no-install"],
          true,
        );
        if (platform === "ios") {
          const output = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-client-" });
          const { mobile } = yield* roots;
          yield* command("pod", ["install"], true, path.join(mobile, "ios"));
          // Target this simulator only, without Expo's desktop activation or log streaming.
          yield* command(
            "xcrun",
            [
              "xcodebuild",
              "-workspace",
              path.join(mobile, "ios/T3CodeDev.xcworkspace"),
              "-scheme",
              "T3CodeDev",
              "-configuration",
              "Debug",
              "-destination",
              `id=${device}`,
              "-derivedDataPath",
              output,
              "build",
            ],
            true,
          );
          yield* command(
            "xcrun",
            [
              "simctl",
              "install",
              device,
              path.join(output, "Build/Products/Debug-iphonesimulator/T3CodeDev.app"),
            ],
            true,
          );
        } else {
          yield* command(
            "vp",
            [
              "exec",
              "expo",
              "run:android",
              "--device",
              device,
              "--no-bundler",
              "--variant",
              "debug",
            ],
            true,
          );
        }
      }).pipe(Effect.scoped),
      saveRecord: Effect.fn(function* (record: NativeClientRecord) {
        yield* fs.makeDirectory(path.dirname(recordPath), { recursive: true });
        yield* fs.writeFileString(recordPath, yield* encodeRecord(record));
      }),
    };
    if (mode === "ensure") {
      yield* Console.log(yield* encodeOutput(yield* ensureClient(operations)));
    } else {
      const current = yield* operations.fingerprint;
      const status = clientStatus(
        current,
        yield* operations.installedBinary,
        yield* operations.readRecord,
      );
      yield* Console.log(
        yield* encodeOutput({
          status,
          fingerprint: current,
          next:
            status === "compatible"
              ? "Start Metro with vp run dev:client"
              : `node scripts/mobile-native-client.ts ensure ${platform} ${device}`,
        }),
      );
      process.exitCode = status === "compatible" ? 0 : 2;
    }
  }),
);

if (import.meta.main) {
  Command.run(main, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
