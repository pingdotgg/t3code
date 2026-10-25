import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isCommandAvailable, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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
        Schema.Array(
          Schema.Struct({ udid: Schema.String, name: Schema.String, state: Schema.String }),
        ),
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

export type ArtifactSource = "local" | "remote" | "build";

/** Keep native sources stable during ensure, as with a normal build; endpoint checks reject detected edits. */
export const ensureClient = Effect.fn("ensureClient")(function* <E, R, E2, R2>(operations: {
  fingerprint: Effect.Effect<string, E, R>;
  installedBinary: Effect.Effect<string | null, E, R>;
  readRecord: Effect.Effect<NativeClientRecord | null, E, R>;
  install: (fingerprint: string) => Effect.Effect<ArtifactSource, E, R>;
  saveRecord: (record: NativeClientRecord) => Effect.Effect<void, E2, R2>;
}) {
  const fingerprint = yield* operations.fingerprint;
  const status = clientStatus(
    fingerprint,
    yield* operations.installedBinary,
    yield* operations.readRecord,
  );
  if (status === "compatible") {
    return { status, installed: false, fingerprint };
  }
  const source = yield* operations.install(fingerprint);
  const binary = yield* operations.installedBinary;
  if (binary === null)
    return yield* new NativeClientError({
      message: "Install finished but the development client is not on the device.",
    });
  yield* operations.saveRecord({ fingerprint, binary });
  return { status: "compatible" as const, installed: true, source, fingerprint };
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
  const visit = Effect.fn("mobile-native-client.visit")(function* (
    relative: string,
  ): Effect.fn.Return<void, FileSystemError, FileSystem.FileSystem | Crypto.Crypto> {
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
        const chunks = yield* fs.stream(absolute, { chunkSize: 65536 }).pipe(
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
export const resolveAdb = Effect.gen(function* () {
  if (yield* isCommandAvailable("adb")) return "adb";
  const environment = yield* HostProcess.Environment;
  const path = yield* Path.Path;
  const executable = (yield* HostProcess.Platform) === "win32" ? "adb.exe" : "adb";
  for (const sdk of [environment.ANDROID_SDK_ROOT, environment.ANDROID_HOME]) {
    if (!sdk) continue;
    const candidate = path.join(sdk, "platform-tools", executable);
    if (yield* isCommandAvailable(candidate)) return candidate;
  }
  return yield* new NativeClientError({
    message:
      "adb was not found on PATH or in ANDROID_SDK_ROOT/ANDROID_HOME. Install Android SDK platform-tools.",
  });
});

/** Build tool output goes to this file instead of the caller's terminal; null streams it. */
const BuildLog = Context.Reference<string | null>("nativeClient/BuildLog", {
  defaultValue: () => null,
});

const command = Effect.fn("nativeClient.command")(function* (
  program: string,
  args: string[],
  inherit = false,
  cwd?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcess.Environment;
  const log = inherit ? yield* BuildLog : null;
  const spawn = yield* resolveSpawnCommand(program === "adb" ? yield* resolveAdb : program, args);
  const child = yield* spawner.spawn(
    ChildProcess.make(spawn.command, spawn.args, {
      shell: spawn.shell,
      cwd: cwd ?? (yield* roots).mobile,
      env: {
        ...environment,
        APP_VARIANT: "development",
        MOBILE_VERSION_POLICY: "appVersion",
        T3CODE_IOS_PERSONAL_TEAM: "0",
        CI: "1",
        EXPO_NO_GIT_STATUS: "1",
        // macOS tar otherwise adds AppleDouble entries that change the extracted bundle.
        COPYFILE_DISABLE: "1",
      },
      stdin: "ignore",
      stdout: inherit && !log ? "inherit" : "pipe",
      stderr: inherit && !log ? "inherit" : "pipe",
    }),
  );
  if (log) {
    const fs = yield* FileSystem.FileSystem;
    const append = <E>(stream: Stream.Stream<Uint8Array, E>) =>
      stream.pipe(Stream.run(fs.sink(log, { flag: "a" })));
    const [, , code] = yield* Effect.all(
      [append(child.stdout), append(child.stderr), child.exitCode],
      { concurrency: "unbounded" },
    );
    if (code === 0) return "";
    const tail = (yield* fs.readFileString(log)).trimEnd().split("\n").slice(-40).join("\n");
    return yield* new NativeClientError({
      message: `${program} ${args[0]} failed (${code}). Last lines:\n${tail}\nFull log: ${log}`,
    });
  }
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
  const output = yield* command(yield* HostProcess.ExecutablePath, [
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

const runtimeName = (runtime: string) =>
  runtime
    .replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "")
    .replace(/-(\d+)-(\d+)$/, " $1.$2");

/** Validate the named device, or pick the only booted one; otherwise list exact commands to choose from. */
const resolveDevice = Effect.fn("nativeClient.resolveDevice")(function* (
  platform: NativePlatform,
  requested: string | undefined,
) {
  const choose = (candidates: ReadonlyArray<{ id: string; label: string }>, problem: string) =>
    new NativeClientError({
      message: [
        problem,
        ...candidates.map(
          ({ id, label }) => `  vp run mobile:install ${platform} ${id}   # ${label}`,
        ),
      ].join("\n"),
    });
  if (platform === "ios") {
    if ((yield* HostProcess.Platform) !== "darwin")
      return yield* new NativeClientError({
        message: "Run iOS installs on the Mac that hosts the simulator.",
      });
    // The shared iOS client is an arm64 simulator build; Intel simulators cannot run it.
    if ((yield* HostProcess.Architecture) !== "arm64")
      return yield* new NativeClientError({
        message: "mobile:install needs an Apple silicon Mac. Use vp run ios:dev on Intel Macs.",
      });
    const listing = yield* decodeSimulators(
      yield* command("xcrun", ["simctl", "list", "devices", "available", "--json"]),
    );
    const simulators = Object.entries(listing.devices).flatMap(([runtime, devices]) =>
      devices.map((device) => ({ ...device, label: `${device.name} (${runtimeName(runtime)})` })),
    );
    const booted = simulators
      .filter((simulator) => simulator.state === "Booted")
      .map(({ udid, label }) => ({ id: udid, label }));
    if (requested === undefined) {
      if (booted.length === 1) return booted[0]!;
      return yield* booted.length === 0
        ? new NativeClientError({
            message:
              "No iOS simulator is booted. Open one with device_open, or boot one: xcrun simctl boot <udid>",
          })
        : choose(booted, "Several iOS simulators are booted. Pick one:");
    }
    const simulator = simulators.find((entry) => entry.udid === requested);
    if (!simulator)
      return yield* choose(booted, `No available iOS simulator with UDID ${requested}. Booted:`);
    if (simulator.state !== "Booted")
      return yield* new NativeClientError({
        message: `Boot the selected simulator first: xcrun simctl boot ${requested}`,
      });
    return { id: simulator.udid, label: simulator.label };
  }
  const attached = (yield* command("adb", ["devices", "-l"]))
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map(([id, state, ...details]) => ({
      id: id!,
      state: state!,
      label: details.find((detail) => detail.startsWith("model:"))?.slice(6) ?? id!,
    }));
  const ready = attached.filter((device) => device.state === "device");
  const device =
    requested === undefined ? ready : attached.filter((entry) => entry.id === requested);
  if (requested === undefined && ready.length !== 1)
    return yield* ready.length === 0
      ? new NativeClientError({
          message:
            "No Android emulator or phone is connected. Open one with device_open, or start an emulator.",
        })
      : choose(ready, "Several Android devices are connected. Pick one:");
  const selected = device[0];
  if (!selected)
    return yield* choose(ready, `Android device ${requested} is not connected. Ready:`);
  if (selected.state === "unauthorized")
    return yield* new NativeClientError({
      message: `Unlock ${selected.label} and accept the USB debugging prompt, then run this again.`,
    });
  if (selected.state !== "device")
    return yield* new NativeClientError({
      message: `Android device ${selected.id} is ${selected.state}, not ready.`,
    });
  // Emulators report a generic model; their AVD name is what users recognize.
  const avd = selected.id.startsWith("emulator-")
    ? yield* command("adb", ["-s", selected.id, "emu", "avd", "name"]).pipe(
        Effect.map((output) => output.split("\n")[0]?.trim()),
        Effect.orElseSucceed(() => undefined),
      )
    : undefined;
  return { id: selected.id, label: avd || selected.label };
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

/** Preserve input-invalidated Gradle/.cxx caches; exclude app/build because its tasks omit inputs. Ignore cache failures. */
export const prebuildAndroid = Effect.fn("nativeClient.prebuildAndroid")(function* <E, R>(
  mobile: string,
  prebuild: Effect.Effect<void, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const android = path.join(mobile, "android");
  // Sibling renames stay on one filesystem; interrupted runs leave this gitignored cache for next-run cleanup.
  const saved = path.join(mobile, ".android-cache");
  const caches = [".gradle", "app/.cxx"];
  const clear = fs.remove(saved, { recursive: true, force: true }).pipe(Effect.ignore);
  const move = (from: string, to: string) =>
    Effect.forEach(
      caches,
      (cache) =>
        Effect.gen(function* () {
          const source = path.join(from, cache);
          const target = path.join(to, cache);
          if (!(yield* fs.exists(source)) || (yield* fs.exists(target))) return;
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.rename(source, target);
        }).pipe(Effect.ignore),
      { discard: true },
    );
  yield* Effect.acquireUseRelease(
    clear.pipe(Effect.andThen(move(android, saved))),
    () => prebuild,
    () => move(saved, android).pipe(Effect.andThen(clear)),
  );
});

const artifactNames = { ios: "T3CodeDev.app", android: "app-debug.apk" } as const;
// R2 requires equal-sized parts and Workers cap request bodies at 100 MB.
const partSize = 64 * 1024 * 1024;
const RemoteCredentials = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Struct({ name: Schema.String, token: Schema.String })),
);
const decodeCredentials = Schema.decodeUnknownEffect(RemoteCredentials);
const decodeEndpoint = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ endpoint: Schema.String })),
);
const decodeUpload = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({ exists: Schema.Literal(true) }),
    Schema.Struct({ uploadId: Schema.String }),
  ]),
);
const decodePart = Schema.decodeUnknownEffect(Schema.Struct({ etag: Schema.String }));

interface RemoteCache {
  readonly url: string;
  readonly telemetry: string;
  readonly name: string;
  readonly token: string;
}

/** The shared task-cache login (infra/task-cache/install.sh) also authorizes native clients. */
const remoteCache = Effect.fn("nativeClient.remoteCache")(
  function* (home: string) {
    const environment = yield* HostProcess.Environment;
    if (environment.T3_NATIVE_CLIENT_CACHE === "off") return null;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { endpoint } = yield* decodeEndpoint(
      yield* fs.readFileString(path.join((yield* roots).repo, ".task-cache.json")),
    );
    const credentials = yield* decodeCredentials(
      yield* fs.readFileString(path.join(home, ".config/t3-task-cache/credentials.json")),
    );
    const login = credentials[endpoint];
    if (!login) return null;
    const base = endpoint.replace(/\/$/, "");
    return {
      url: `${base}/native-clients`,
      telemetry: `${base}/telemetry`,
      ...login,
    } satisfies RemoteCache;
  },
  Effect.catch(() => Effect.succeed(null)),
);

const authorized = (remote: RemoteCache, request: HttpClientRequest.HttpClientRequest) =>
  request.pipe(HttpClientRequest.basicAuth(remote.name, remote.token));

// Build duration lives beside the artifact so hits can report the time they saved.
const sidecar = (directory: string) => `${directory}.json`;
const decodeSidecar = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ buildMs: Schema.Number })),
);
const readBuildMs = (directory: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(sidecar(directory))),
    Effect.flatMap(decodeSidecar),
    Effect.map(({ buildMs }) => buildMs),
    Effect.orElseSucceed(() => 0),
  );
const writeBuildMs = (directory: string, buildMs: number) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.writeFileString(sidecar(directory), JSON.stringify({ buildMs }))),
    Effect.ignore,
  );

/** Download into a sibling staging directory and publish only after the digest matches. */
const download = Effect.fn("nativeClient.download")(function* (
  remote: RemoteCache,
  platform: NativePlatform,
  key: string,
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    authorized(remote, HttpClientRequest.get(`${remote.url}/${key}`)),
  );
  if (response.status === 404) return false;
  yield* HttpClientResponse.filterStatusOk(response);
  const expected = response.headers["x-t3-digest"] ?? "";
  if (!/^[a-f0-9]{64}$/.test(expected))
    return yield* new NativeClientError({ message: "Cached native client has no digest." });
  yield* Console.error(`Downloading native client ${key} from the shared cache...`);
  const staging = yield* fs.makeTempDirectory({
    directory: path.dirname(target),
    prefix: ".download-",
  });
  return yield* Effect.gen(function* () {
    if (platform === "ios") {
      const archive = `${staging}.tgz`;
      yield* response.stream.pipe(
        Stream.run(fs.sink(archive)),
        Effect.andThen(command("tar", ["-xzf", archive, "-C", staging])),
        Effect.ensuring(fs.remove(archive, { force: true }).pipe(Effect.ignore)),
      );
    } else {
      yield* response.stream.pipe(Stream.run(fs.sink(path.join(staging, artifactNames.android))));
    }
    if ((yield* hashBundle(staging)) !== expected)
      return yield* new NativeClientError({ message: "Cached native client failed verification." });
    yield* publish(staging, target);
    const buildMs = Number(response.headers["x-t3-build-ms"] ?? 0);
    yield* writeBuildMs(target, Number.isSafeInteger(buildMs) ? buildMs : 0);
    return true;
  }).pipe(
    Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

/** Upload in fixed-size parts; any failure aborts the upload and leaves the cache unchanged. */
const upload = Effect.fn("nativeClient.upload")(function* (
  remote: RemoteCache,
  platform: NativePlatform,
  key: string,
  artifact: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const created = yield* client
    .execute(
      authorized(remote, HttpClientRequest.post(`${remote.url}/${key}/uploads`)).pipe(
        HttpClientRequest.setHeader("x-t3-digest", yield* hashBundle(artifact)),
        HttpClientRequest.setHeader("x-t3-build-ms", String(yield* readBuildMs(artifact))),
      ),
    )
    .pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeUpload),
    );
  if ("exists" in created) return;
  const uploadUrl = `${remote.url}/${key}/uploads/${encodeURIComponent(created.uploadId)}`;
  yield* Console.error(`Uploading native client ${key} to the shared cache...`);
  yield* Effect.gen(function* () {
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-upload-" });
    const file =
      platform === "ios"
        ? path.join(directory, "client.tgz")
        : path.join(artifact, artifactNames.android);
    if (platform === "ios")
      yield* command("tar", ["-czf", file, "-C", artifact, artifactNames.ios]);
    const handle = yield* fs.open(file);
    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (let partNumber = 1; ; partNumber++) {
      const buffer = new Uint8Array(partSize);
      let filled = 0;
      while (filled < partSize) {
        const read = Number(yield* handle.read(buffer.subarray(filled)));
        if (read === 0) break;
        filled += read;
      }
      if (filled === 0) break;
      const { etag } = yield* client
        .execute(
          authorized(remote, HttpClientRequest.put(`${uploadUrl}/${partNumber}`)).pipe(
            HttpClientRequest.bodyUint8Array(buffer.subarray(0, filled)),
          ),
        )
        .pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(decodePart),
        );
      parts.push({ partNumber, etag });
      if (filled < partSize) break;
    }
    yield* client.execute(
      authorized(remote, HttpClientRequest.post(`${uploadUrl}/complete`)).pipe(
        HttpClientRequest.bodyJsonUnsafe({ parts }),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.onError(() =>
      client.execute(authorized(remote, HttpClientRequest.delete(uploadUrl))).pipe(Effect.ignore),
    ),
  );
});

const publish = Effect.fn("nativeClient.publish")(function* (staging: string, target: string) {
  const fs = yield* FileSystem.FileSystem;
  // A concurrent ensure may have published the same fingerprint first; either copy is valid.
  if (yield* fs.exists(target)) return;
  yield* fs.rename(staging, target);
});

const build = Effect.fn("nativeClient.build")(function* (
  platform: NativePlatform,
  abi: string | null,
  target: string,
  expected: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { repo, mobile } = yield* roots;
  const tracked = yield* command("git", ["ls-files", `apps/mobile/${platform}`], false, repo);
  if (tracked)
    return yield* new NativeClientError({
      message: "Native directory contains tracked files; clean prebuild would overwrite them.",
    });
  const prebuild = command(
    "vp",
    ["exec", "expo", "prebuild", "--clean", "--platform", platform, "--no-install"],
    true,
  ).pipe(Effect.asVoid);
  yield* platform === "android" ? prebuildAndroid(mobile, prebuild) : prebuild;
  const staging = yield* fs.makeTempDirectory({
    directory: path.dirname(target),
    prefix: ".build-",
  });
  yield* Effect.gen(function* () {
    if (platform === "ios") {
      const output = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-client-" });
      yield* command("pod", ["install"], true, path.join(mobile, "ios"));
      // One device-independent arm64 simulator build installs on every iPhone and iPad simulator.
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
          "generic/platform=iOS Simulator",
          "-derivedDataPath",
          output,
          "ARCHS=arm64",
          "ONLY_ACTIVE_ARCH=NO",
          "build",
        ],
        true,
      );
      yield* command("ditto", [
        path.join(output, "Build/Products/Debug-iphonesimulator", artifactNames.ios),
        path.join(staging, artifactNames.ios),
      ]);
    } else {
      const android = path.join(mobile, "android");
      yield* command(
        path.join(android, (yield* HostProcess.Platform) === "win32" ? "gradlew.bat" : "gradlew"),
        ["app:assembleDebug", `-PreactNativeArchitectures=${abi}`],
        true,
        android,
      );
      yield* fs.copyFile(
        path.join(android, "app/build/outputs/apk/debug", artifactNames.android),
        path.join(staging, artifactNames.android),
      );
    }
    // Native edits during the build would publish this binary under a fingerprint it doesn't match.
    if ((yield* fingerprint(platform)) !== expected)
      return yield* new NativeClientError({
        message: "Native inputs changed during the build, so it was discarded. Run this again.",
      });
    yield* publish(staging, target);
  }).pipe(
    Effect.scoped,
    Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

/** Keep the newest few fingerprints per platform; each artifact is a few hundred megabytes. */
const prune = Effect.fn("nativeClient.prune")(
  function* (parent: string, keep: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* Effect.forEach(
      (yield* fs.readDirectory(parent)).filter(
        (name) => !name.startsWith(".") && !name.endsWith(".json"),
      ),
      (name) =>
        fs.stat(path.join(parent, name)).pipe(
          Effect.map((info) => ({
            name,
            modified: Option.getOrUndefined(info.mtime)?.getTime() ?? 0,
          })),
        ),
    );
    const stale = entries
      .filter(({ name }) => name !== keep)
      .sort((a, b) => b.modified - a.modified)
      .slice(2);
    yield* Effect.forEach(
      stale,
      ({ name }) =>
        fs
          .remove(path.join(parent, name), { recursive: true, force: true })
          .pipe(Effect.andThen(fs.remove(sidecar(path.join(parent, name)), { force: true }))),
      { discard: true },
    );
  },
  (effect) => Effect.ignore(effect),
);

/** Local artifact, then the shared cache, then a build that is shared back when credentials allow. */
export const resolveArtifact = Effect.fn("nativeClient.resolveArtifact")(function* (
  home: string,
  platform: NativePlatform,
  abi: string | null,
  fingerprint: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const key = `${platform}/${abi ? `development-${abi}` : "development"}/${fingerprint}`;
  const directory = path.join(home, ".cache/t3code/native-clients/artifacts", key);
  const artifact = { directory, file: path.join(directory, artifactNames[platform]) };
  if (yield* fs.exists(artifact.file)) {
    yield* Console.error(`Using cached client ${key}.`);
    // Pruning keeps the most recently used, so a client another checkout is installing stays.
    const now = yield* Clock.currentTimeMillis;
    yield* fs.utimes(directory, now / 1000, now / 1000).pipe(Effect.ignore);
    return { ...artifact, source: "local" as const, buildMs: yield* readBuildMs(directory) };
  }
  yield* fs.makeDirectory(path.dirname(directory), { recursive: true });
  const remote = yield* remoteCache(home);
  if (remote) {
    const downloaded = yield* download(remote, platform, key, directory).pipe(
      Effect.catch((error) =>
        Console.error(`Shared native client cache unavailable (${describe(error)}).`).pipe(
          Effect.as(false),
        ),
      ),
    );
    if (downloaded) {
      yield* prune(path.dirname(directory), fingerprint);
      return { ...artifact, source: "remote" as const, buildMs: yield* readBuildMs(directory) };
    }
  }
  const log = yield* BuildLog;
  yield* Console.error(
    `No cached client for ${key}. Building it once for every machine (5-15 min)${log ? `. Log: ${log}` : ""}`,
  );
  const started = yield* Clock.currentTimeMillis;
  yield* build(platform, abi, directory, fingerprint);
  yield* writeBuildMs(directory, (yield* Clock.currentTimeMillis) - started);
  yield* prune(path.dirname(directory), fingerprint);
  if (remote && (yield* HostProcess.Environment).T3_NATIVE_CLIENT_CACHE !== "read") {
    yield* upload(remote, platform, key, directory).pipe(
      Effect.catch((error) => Console.error(`Native client was not shared (${describe(error)}).`)),
    );
  }
  return { ...artifact, source: "build" as const, buildMs: 0 };
});

const describe = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : String(error);

const install = Effect.fn("nativeClient.install")(function* (
  platform: NativePlatform,
  device: string,
  file: string,
) {
  if (platform === "ios") {
    yield* command("xcrun", ["simctl", "install", device, file], true);
    return;
  }
  yield* command("adb", ["-s", device, "install", "-r", "-d", file]).pipe(
    Effect.catchTags({
      NativeClientError: (error) =>
        Effect.fail(
          error.message.includes("INSTALL_FAILED_UPDATE_INCOMPATIBLE")
            ? new NativeClientError({
                message: `The installed client has a different signature. Remove it with adb -s ${device} uninstall ${bundleId} (this clears its pairings), then run ensure again.`,
              })
            : error,
        ),
    }),
  );
  // Emulators reach Metro through 10.0.2.2; a phone on USB needs the port forwarded.
  if ((yield* command("adb", ["-s", device, "shell", "getprop", "ro.kernel.qemu"])) !== "1")
    yield* command("adb", ["-s", device, "reverse", "tcp:8081", "tcp:8081"]).pipe(Effect.ignore);
});

const reportTelemetry = Effect.fn("nativeClient.reportTelemetry")(
  function* (
    home: string,
    task: string,
    source: "local" | "remote" | "executed" | "failed",
    savedMs: number,
  ) {
    const remote = yield* remoteCache(home);
    if (!remote) return;
    const environment = yield* HostProcess.Environment;
    const recordedAt = yield* Clock.currentTimeMillis;
    // Same machine label as Vite task reports (infra/task-cache/src/telemetry.ts).
    const fs = yield* FileSystem.FileSystem;
    const machine = yield* fs.readFileString(`${home}/.agents/MACHINE`).pipe(
      Effect.map((value) => value.trim()),
      Effect.orElseSucceed(() => ""),
    );
    const host =
      environment.T3_TASK_CACHE_HOST ||
      machine ||
      (environment.GITHUB_ACTIONS === "true"
        ? `${environment.RUNNER_ENVIRONMENT || "github"}/${environment.RUNNER_OS}/${environment.RUNNER_ARCH}`
        : yield* HostProcess.Hostname);
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    yield* client.execute(
      authorized(remote, HttpClientRequest.post(remote.telemetry)).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          id: yield* digest(`${host}:${task}:${recordedAt}:${yield* Random.nextInt}`),
          recordedAt,
          host,
          platform: yield* HostProcess.Platform,
          arch: yield* HostProcess.Architecture,
          ci: environment.CI === "true" || environment.CI === "1",
          runId: environment.GITHUB_RUN_ID ?? "",
          tasks: [{ package: "@t3tools/mobile", task, source, savedMs: Math.round(savedMs) }],
        }),
      ),
    );
  },
  (effect) => effect.pipe(Effect.timeout("5 seconds"), Effect.ignore),
);

const main = Command.make(
  "mobile-native-client",
  {
    mode: Argument.Literals("mode", ["check", "ensure"]),
    platform: Argument.Literals("platform", ["ios", "android"]),
    device: Argument.String("device").pipe(Argument.optional),
  },
  Effect.fn("nativeClient.main")(function* ({ mode, platform, device: requested }) {
    const started = yield* Clock.currentTimeMillis;
    const target = yield* resolveDevice(platform, Option.getOrUndefined(requested));
    const device = target.id;
    yield* Console.error(`Device: ${target.label} (${device})`);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* HostProcess.Environment;
    const home = environment.HOME ?? environment.USERPROFILE;
    if (!home)
      return yield* new NativeClientError({
        message: "HOME or USERPROFILE must be set to store native client records.",
      });
    const cache = path.join(home, ".cache/t3code/native-clients");
    const recordPath = path.join(cache, platform, `${yield* digest(device)}.json`);
    // An iOS simulator build is arm64 for every device; an APK carries only the device's own ABI.
    const abi = Effect.gen(function* () {
      if (platform === "ios") return null;
      const value = yield* command("adb", ["-s", device, "shell", "getprop", "ro.product.cpu.abi"]);
      if (value !== "x86_64" && value !== "arm64-v8a")
        return yield* new NativeClientError({ message: `Unsupported Android ABI ${value}.` });
      return value;
    });
    let task = `native-client:${platform}`;
    let savedMs = 0;
    const operations = {
      fingerprint: fingerprint(platform),
      installedBinary: installedBinary(platform, device),
      readRecord: fs.readFileString(recordPath).pipe(
        Effect.flatMap(decodeRecord),
        Effect.catchTags({ SchemaError: () => Effect.succeed(null) }),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      ),
      install: Effect.fn(function* (fingerprint: string) {
        const deviceAbi = yield* abi;
        if (deviceAbi) task = `native-client:android-${deviceAbi}`;
        const artifact = yield* resolveArtifact(home, platform, deviceAbi, fingerprint);
        savedMs = artifact.buildMs;
        yield* Console.error(`Installing on ${target.label}...`);
        yield* install(platform, device, artifact.file);
        return artifact.source;
      }),
      saveRecord: Effect.fn(function* (record: NativeClientRecord) {
        yield* fs.makeDirectory(path.dirname(recordPath), { recursive: true });
        yield* fs.writeFileString(recordPath, yield* encodeRecord(record));
      }),
    };
    if (mode === "check") {
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
          device,
          next:
            status === "compatible"
              ? "Start Metro with vp run dev:client"
              : `vp run mobile:install ${platform} ${device}`,
        }),
      );
      process.exitCode = status === "compatible" ? 0 : 2;
      return;
    }
    const logs = path.join(cache, "logs");
    yield* fs.makeDirectory(logs, { recursive: true });
    yield* prune(logs, "");
    const stamp = DateTime.formatIso(DateTime.makeUnsafe(started)).replaceAll(":", "-");
    const log = path.join(logs, `${stamp}-${platform}.log`);
    const result = yield* ensureClient(operations).pipe(
      Effect.provideService(BuildLog, environment.T3_NATIVE_CLIENT_VERBOSE === "1" ? null : log),
      Effect.tapError(() => reportTelemetry(home, task, "failed", 0)),
    );
    if (result.installed && result.source)
      yield* reportTelemetry(
        home,
        task,
        result.source === "build" ? "executed" : result.source,
        result.source === "build" ? 0 : savedMs,
      );
    const seconds = Math.round(((yield* Clock.currentTimeMillis) - started) / 1000);
    yield* Console.error(
      result.installed
        ? `Installed on ${target.label} in ${seconds}s (${result.source}). Next: start Metro with vp run dev:client.`
        : `${target.label} already has the client for this checkout. Next: start Metro with vp run dev:client.`,
    );
    yield* Console.log(yield* encodeOutput({ ...result, device, seconds }));
  }),
);

if (import.meta.main) {
  Command.run(main, { version: "0.0.0" }).pipe(
    // Expected failures carry their next step; a stack trace only buries it.
    Effect.catchTags({
      NativeClientError: (error) =>
        Console.error(error.message).pipe(
          Effect.andThen(Effect.sync(() => (process.exitCode = 1))),
        ),
    }),
    Effect.scoped,
    Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
    NodeRuntime.runMain,
  );
}
