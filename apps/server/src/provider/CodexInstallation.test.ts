import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as ModelManifest from "./ModelManifest.ts";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as ServerSettings from "../serverSettings.ts";

const archive = Buffer.from(
  "H4sIAAAAAAAC/+3W0W6DIBQGYB/FcD0sKNSkD7J7aom6tmAQtzXL3n3QZM3qdWVt+n8XoCckJp78wLY3q8bu9Ge2HBbUUp7nYD4H8s9zrNdSsCxnWQLT6JULn8ye09K9h/u2/c0/jSM9xqGzo0+bf3Gdf15WQiD/Kdy61/CA+z8dlO9Wrv2387+c5Z9VZY38p7BY0+Gh8t/sVauLt9Ga9Pnnop7ln1e4/6fxRQ7qZCf/qt3YW0M2OX/JyfvljbCCy3XBSaiGH9VqH4tKuaZbC6qG4aDpTrmP3sQV2nh3Gmxvzqsud0vyjaABAAAAAAAAAAAAAAAk8gOq19rvACgAAA==",
  "base64",
);
const asset = {
  version: "0.156.1",
  target: "aarch64-apple-darwin",
  url: "https://github.com/openai/codex/releases/download/test/package.tar.gz",
  archiveBytes: archive.length,
};
const makeHarness = Effect.fn("test.makeCodexInstallation")(function* (
  input: {
    options?: Partial<CodexInstallation.CodexInstallationOptions>;
    manifestCurrent?: Effect.Effect<ModelManifest.ModelManifestData>;
    body?: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>;
    downloadStatus?: number;
    baseDir?: string;
    local?: { version: string; appServerFails?: boolean; versionFails?: boolean };
    platform?: NodeJS.Platform;
    spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
    runtimeRenameFailures?: number;
    githubToken?: string;
    githubCredential?: () => string | undefined;
    releaseResponse?: () => unknown;
    enableProviderUpdateChecks?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir =
    input.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-install-test-" }));
  const localDirectory = `${baseDir}/local`;
  const localBinaryPath = `${localDirectory}/codex${input.platform === "win32" ? ".exe" : ""}`;
  const probeLog = `${baseDir}/local-probes.txt`;
  if (input.local) {
    yield* fs.makeDirectory(localDirectory, { recursive: true });
    yield* fs.writeFileString(
      localBinaryPath,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${probeLog}'\ncase "$1" in\n--version) ${input.local.versionFails ? "exit 1" : `printf '%s\\n' 'codex-cli ${input.local.version}'`};;\napp-server) exit ${input.local.appServerFails ? "1" : "0"};;\nesac\n`,
      { mode: 0o755 },
    );
  }
  let downloads = 0;
  let releaseChecks = 0;
  let credentialInvalidations = 0;
  const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  const digest = yield* Digest.Digest;
  const sha256 = Hex.encode(yield* digest.digest(Digest.sha256, archive).pipe(Effect.orDie));
  let runtimeRenameFailures = input.runtimeRenameFailures ?? 0;
  const failedRenames = yield* Queue.unbounded<void>();
  const lockingFs: FileSystem.FileSystem = {
    ...fs,
    // Suspended so each retry of the same effect is a fresh attempt, like the real rename.
    rename: (from, to) =>
      Effect.suspend(() =>
        /[/\\]runtime$/u.test(from) && runtimeRenameFailures-- > 0
          ? Queue.offer(failedRenames, undefined).pipe(
              Effect.andThen(
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: from,
                  }),
                ),
              ),
            )
          : fs.rename(from, to),
      ),
  };
  const spawner = input.spawner ?? (yield* ChildProcessSpawner.ChildProcessSpawner);
  const installation = yield* CodexInstallation.makeCodexInstallation({
    baseDir,
    releaseAsset: { ...asset, sha256 },
    validate: () => Effect.void,
    ...input.options,
  }).pipe(
    Effect.provideService(ModelManifest.ModelManifest, {
      current: input.manifestCurrent ?? Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      refresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      forceRefresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      refreshInBackground: Effect.void,
    }),
    Effect.provideService(HostProcess.Platform, input.platform ?? "darwin"),
    Effect.provideService(HostProcess.Architecture, "arm64"),
    Effect.provideService(HostProcess.Environment, {
      PATH: input.local ? localDirectory : "",
      SystemRoot: "C:\\Windows",
    }),
    Effect.provideService(FileSystem.FileSystem, lockingFs),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(GitHubCredentials.GitHubCredentials, {
      saved: () => Effect.succeedNone,
      fingerprint: (_host, token) => Effect.succeed(token),
      get: (host) => {
        const token = input.githubCredential?.() ?? input.githubToken;
        return token === undefined
          ? Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }))
          : Effect.succeed({
              host,
              token: Redacted.make(token),
              source: "settings",
              fingerprint: token,
            });
      },
      invalidate: () => Effect.sync(() => credentialInvalidations++).pipe(Effect.asVoid),
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push({ url: request.url, authorization: request.headers.authorization });
          if (request.url === "https://api.github.com/repos/openai/codex/releases/latest") {
            releaseChecks++;
            const body = input.releaseResponse?.() ?? releaseMetadata(asset.version, sha256);
            return HttpClientResponse.fromWeb(
              request,
              body instanceof Response ? body : Response.json(body),
            );
          }
          downloads++;
          return Object.defineProperty(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: input.downloadStatus ?? 200 }),
            ),
            "stream",
            {
              value: input.body ?? Stream.succeed(archive),
            },
          );
        }),
      ),
    ),
    Effect.provide(
      ServerSettings.ServerSettingsService.layerTest({
        enableProviderUpdateChecks: input.enableProviderUpdateChecks ?? true,
      }),
    ),
  );
  return {
    installation,
    fs,
    baseDir,
    localBinaryPath,
    probeLog,
    failedRenames,
    downloads: () => downloads,
    releaseChecks: () => releaseChecks,
    credentialInvalidations: () => credentialInvalidations,
    requests: () => requests,
  };
});
const terminalState = (installation: CodexInstallation.CodexInstallation["Service"]) =>
  installation.changes.pipe(
    Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.effect.each(["0.156.0", "0.156.1", "0.156.2", "0.157.0"])(
  "reuses installed Codex %s without downloading or taking ownership of it",
  (version) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        local: { version },
        options: { releaseAsset: undefined },
      });
      expect(yield* h.installation.start()).toMatchObject({
        source: "local",
        phase: "succeeded",
        installedVersion: version,
        executablePath: h.localBinaryPath,
        canRemove: false,
      });
      expect(yield* h.installation.resolve()).toMatchObject({
        source: "local",
        executablePath: h.localBinaryPath,
        managedVersionDirectory: null,
        version,
      });
      yield* h.installation.acquire().pipe(Effect.scoped);
      expect(h.downloads()).toBe(0);
      expect(h.releaseChecks()).toBe(0);
      expect(yield* h.fs.exists(h.installation.managedDirectory)).toBe(false);
      expect((yield* h.fs.readFileString(h.probeLog)).trim().split("\n")).toEqual([
        "--version",
        "app-server --help",
      ]);
      yield* h.installation.remove();
      expect(yield* h.fs.exists(h.localBinaryPath)).toBe(true);
      expect((yield* h.installation.state).source).toBe("local");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
it.effect.each([true, false])(
  "acquires only the managed runtime when requested with managed installation %s",
  (managedInstalled) =>
    Effect.gen(function* () {
      const first = yield* makeHarness();
      if (managedInstalled) {
        yield* first.installation.start();
        expect((yield* terminalState(first.installation)).phase).toBe("succeeded");
      }
      const h = yield* makeHarness({ baseDir: first.baseDir, local: { version: "0.156.2" } });
      expect(yield* h.installation.acquire().pipe(Effect.scoped)).toMatchObject({
        source: "local",
        executablePath: h.localBinaryPath,
        version: "0.156.2",
      });
      const managed = h.installation.acquire({ managedOnly: true }).pipe(Effect.scoped);
      if (managedInstalled) {
        expect(yield* managed).toMatchObject({
          source: "managed",
          executablePath: `${h.baseDir}/tools/codex/0.156.1/bin/codex`,
          version: "0.156.1",
        });
      } else {
        expect((yield* Effect.flip(managed)).detail).toBe(
          "Codex is not installed in T3 Code. Install it to continue.",
        );
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("installs a managed runtime when requested despite a compatible host Codex", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ local: { version: "0.156.1" } });
    const started = yield* h.installation.start({ managedOnly: true });
    expect(started.phase).toBe("downloading");
    expect(started.operationId).not.toBeNull();
    const operationId = started.operationId;
    if (operationId === null) throw new Error("Managed install must have an operation id.");
    const installed = yield* h.installation.changes.pipe(
      Stream.filter((state) => state.operationId === operationId && state.phase === "succeeded"),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    expect(installed.source).toBe("managed");
    expect(installed.executablePath).toBe(`${h.baseDir}/tools/codex/0.156.1/bin/codex`);
    expect(h.downloads()).toBe(1);
    expect(yield* h.fs.exists(h.localBinaryPath)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each([
  { version: "0.128.9" },
  { version: "0.145.0" },
  { version: "0.155.1" },
  { version: "0.155.9" },
  { version: "0.156.1-alpha.1" },
  { version: "unknown" },
  { version: "0.156.1", appServerFails: true },
  { version: "0.156.1", versionFails: true },
])("downloads the pinned release when the local CLI is unsupported or broken: %j", (local) =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ local });
    expect((yield* h.installation.state).installedVersion).toBeNull();
    yield* h.installation.start();
    const installed = yield* terminalState(h.installation);
    expect(installed.phase).toBe("succeeded");
    const executable = yield* h.installation.resolve();
    expect(executable.source).toBe("managed");
    expect(installed.executablePath).toBe(executable.executablePath);
    expect(h.downloads()).toBe(1);
    expect(yield* h.fs.exists(h.localBinaryPath)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

const compileNative = Effect.fn("test.compileNative")(function* (
  executablePath: string,
  source: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const compiler = yield* spawner.spawn(
    ChildProcess.make("cc", ["-x", "c", "-", "-o", executablePath], {
      stdin: Stream.make(new TextEncoder().encode(source)),
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  expect(yield* compiler.exitCode).toBe(0);
}, Effect.scoped);

it.effect("rechecks compatibility after the local executable is replaced", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ local: { version: "0.156.1" } });
    expect((yield* h.installation.resolve()).source).toBe("local");
    yield* h.fs.remove(h.localBinaryPath);
    yield* h.fs.writeFileString(h.localBinaryPath, "#!/bin/sh\nprintf 'codex-cli 0.128.9\\n'\n", {
      mode: 0o755,
    });
    yield* h.installation.start();
    expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
    expect((yield* h.installation.resolve()).source).toBe("managed");
    expect(h.downloads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("rechecks a cached local executable when the shared manifest policy changes", () =>
  Effect.gen(function* () {
    let manifest = ModelManifest.BUNDLED_MODEL_MANIFEST;
    const h = yield* makeHarness({
      local: { version: "0.156.0" },
      manifestCurrent: Effect.sync(() => manifest),
    });
    expect((yield* h.installation.resolve()).source).toBe("local");
    manifest = {
      ...manifest,
      compatibility: [
        {
          driver: "codex",
          t3CodeRange: ">=0.0.42",
          ranges: [
            { range: ">=0.156.1", status: "supported" },
            { range: "<0.156.1", status: "broken" },
          ],
        },
      ],
    };
    yield* h.installation.start();
    expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
    expect((yield* h.installation.resolve()).source).toBe("managed");
    expect(h.downloads()).toBe(1);
    expect((yield* h.fs.readFileString(h.probeLog)).trim().split("\n")).toEqual([
      "--version",
      "app-server --help",
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("uses bundled Codex compatibility when the remote manifest omits its policy", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      local: { version: "0.156.0" },
      manifestCurrent: Effect.succeed({
        ...ModelManifest.BUNDLED_MODEL_MANIFEST,
        compatibility: [],
      }),
    });
    expect((yield* h.installation.start()).source).toBe("local");
    expect(h.downloads()).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each([
  { kind: "script", name: "volta-shim" },
  { kind: "native", name: "volta-shim" },
  { kind: "native", name: "mise" },
  { kind: "native", name: "aqua-proxy" },
])("preserves the invoked name of $kind $name launcher symlinks", ({ kind, name }) =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ local: { version: "0.156.1" } });
    const launcher = `${h.baseDir}/${name}`;
    if (kind === "native") {
      const payload = `${h.baseDir}/codex.js`;
      yield* h.fs.rename(h.localBinaryPath, payload);
      yield* compileNative(
        launcher,
        `#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  const char *name = strrchr(argv[0], '/');
  if (strcmp(name ? name + 1 : argv[0], "codex") != 0) return 1;
  execv(${JSON.stringify(payload)}, argv);
  return 1;
}
`,
      );
    } else {
      yield* h.fs.writeFileString(
        launcher,
        '#!/bin/sh\ncase "$0" in */codex) ;; *) exit 1;; esac\ncase "$1" in --version) printf "codex-cli 0.156.1\\n";; app-server) exit 0;; esac\n',
        { mode: 0o755 },
      );
      yield* h.fs.remove(h.localBinaryPath);
    }
    yield* h.fs.symlink(launcher, h.localBinaryPath);
    expect(yield* h.installation.start()).toMatchObject({ source: "local", phase: "succeeded" });
    expect((yield* h.installation.resolve()).executablePath).toBe(h.localBinaryPath);
    expect(h.downloads()).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "installs the complete verified package in tools/codex/version and survives a restart",
  () =>
    Effect.gen(function* () {
      const { installation, fs, baseDir } = yield* makeHarness();
      yield* installation.start();
      expect((yield* terminalState(installation)).phase).toBe("succeeded");
      const executable = yield* installation.resolve();
      expect(executable.executablePath).toBe(`${baseDir}/tools/codex/0.156.1/bin/codex`);
      expect(
        yield* fs.readFileString(`${executable.managedVersionDirectory}/bin/codex-code-mode-host`),
      ).toBe("host");
      expect(yield* fs.readFileString(`${executable.managedVersionDirectory}/codex-path/rg`)).toBe(
        "rg",
      );
      const restarted = yield* makeHarness({ baseDir });
      expect((yield* restarted.installation.resolve()).version).toBe("0.156.1");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("requires an update before running an older activated managed installation", () =>
  Effect.gen(function* () {
    const first = yield* makeHarness();
    yield* first.installation.start();
    yield* terminalState(first.installation);
    const executable = yield* first.installation.resolve();
    const oldDirectory = `${first.installation.managedDirectory}/0.155.1`;
    yield* first.fs.rename(executable.managedVersionDirectory!, oldDirectory);
    for (const name of ["codex-package.json", ".install-complete.json"]) {
      const file = `${oldDirectory}/${name}`;
      yield* first.fs.writeFileString(
        file,
        (yield* first.fs.readFileString(file)).replaceAll("0.156.1", "0.155.1"),
      );
    }
    yield* first.fs.writeFileString(
      `${first.installation.managedDirectory}/active.json`,
      '{"version":"0.155.1"}',
    );
    const restarted = yield* makeHarness({ baseDir: first.baseDir });
    expect((yield* Effect.flip(restarted.installation.resolve())).detail).toContain(
      "outside the supported range",
    );
    yield* restarted.installation.start();
    expect((yield* terminalState(restarted.installation)).phase).toBe("succeeded");
    expect((yield* restarted.installation.resolve()).version).toBe("0.156.1");
    expect(restarted.downloads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["enabled", "disabled", "discovery fails"] as const)(
  "updates an older supported managed installation after startup discovery: %s",
  (policy) =>
    Effect.gen(function* () {
      const first = yield* makeHarness();
      yield* first.installation.start();
      yield* terminalState(first.installation);
      const executable = yield* first.installation.resolve();
      const oldDirectory = `${first.installation.managedDirectory}/0.156.0`;
      yield* first.fs.rename(executable.managedVersionDirectory!, oldDirectory);
      for (const name of ["codex-package.json", ".install-complete.json"]) {
        const file = `${oldDirectory}/${name}`;
        yield* first.fs.writeFileString(
          file,
          (yield* first.fs.readFileString(file)).replaceAll("0.156.1", "0.156.0"),
        );
      }
      yield* first.fs.writeFileString(
        `${first.installation.managedDirectory}/active.json`,
        '{"version":"0.156.0"}',
      );
      const restarted = yield* makeHarness({
        baseDir: first.baseDir,
        options: { releaseAsset: undefined },
        enableProviderUpdateChecks: policy !== "disabled",
        releaseResponse: () =>
          policy === "discovery fails" ? Response.json({}, { status: 503 }) : undefined,
      });
      expect(restarted.releaseChecks()).toBe(policy === "disabled" ? 0 : 1);
      if (policy !== "enabled") {
        expect((yield* restarted.installation.state).phase).toBe("idle");
        expect((yield* restarted.installation.state).operationId).toBeNull();
        expect((yield* restarted.installation.resolve()).version).toBe("0.156.0");
        expect(restarted.downloads()).toBe(0);
        expect(
          yield* first.fs.readFileString(`${first.installation.managedDirectory}/active.json`),
        ).toBe('{"version":"0.156.0"}');
        if (policy === "disabled") {
          yield* restarted.installation.start();
          expect((yield* terminalState(restarted.installation)).phase).toBe("succeeded");
          expect((yield* restarted.installation.resolve()).version).toBe(asset.version);
          expect(restarted.releaseChecks()).toBe(1);
          expect(restarted.downloads()).toBe(1);
        }
        return;
      }
      expect((yield* restarted.installation.state).operationId).not.toBeNull();
      expect((yield* terminalState(restarted.installation)).phase).toBe("succeeded");
      expect((yield* restarted.installation.resolve()).version).toBe("0.156.1");
      expect(restarted.downloads()).toBe(1);
      yield* restarted.installation.refresh({ fresh: true });
      expect(restarted.downloads()).toBe(1);
      yield* restarted.installation.remove();
      yield* restarted.installation.refresh({ fresh: true });
      expect((yield* restarted.installation.state).installedVersion).toBeNull();
      expect(restarted.downloads()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("rejects corrupted downloads without publishing a runtime", () =>
  Effect.gen(function* () {
    const { installation, fs } = yield* makeHarness({
      options: { releaseAsset: { ...asset, sha256: "0".repeat(64) } },
    });
    yield* installation.start();
    const state = yield* terminalState(installation);
    expect(state.phase).toBe("failed");
    expect(state.message).toContain("SHA-256");
    expect(yield* fs.exists(`${installation.managedDirectory}/active.json`)).toBe(false);
    expect(yield* fs.exists(`${installation.managedDirectory}/0.156.1`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["interrupted body", "HTTP 404"] as const)(
  "reports a download failure for %s without blaming disk access",
  (failure) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.get(asset.url);
      const response = HttpClientResponse.fromWeb(request, new Response(null));
      const h = yield* makeHarness(
        failure === "HTTP 404"
          ? { downloadStatus: 404 }
          : {
              body: Stream.concat(
                Stream.succeed(archive.subarray(0, 10)),
                Stream.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.DecodeError({
                      request,
                      response,
                      cause: new TypeError("terminated"),
                    }),
                  }),
                ),
              ),
            },
      );
      yield* h.installation.start();
      expect(yield* terminalState(h.installation)).toMatchObject({
        phase: "failed",
        message:
          failure === "HTTP 404"
            ? "The Codex download server returned HTTP 404. Try again later."
            : "The Codex download was interrupted. Check your internet connection, then retry installation.",
      });
      expect(h.downloads()).toBe(1);
      expect(yield* h.fs.readDirectory(h.installation.managedDirectory)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "preserves the filesystem failure message when installation cannot create its directory",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-install-test-" });
      const baseDir = `${directory}/not-a-directory`;
      yield* fs.writeFileString(baseDir, "existing file");
      const h = yield* makeHarness({ baseDir });
      yield* h.installation.start();
      expect(yield* terminalState(h.installation)).toMatchObject({
        phase: "failed",
        message: "Could not install Codex. Check disk space and directory access, then try again.",
      });
      expect(h.downloads()).toBe(0);
      expect(yield* fs.readFileString(baseDir)).toBe("existing file");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("reports a download timeout and cleans the staging directory", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stall = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
    const h = yield* makeHarness({
      body: Stream.concat(Stream.succeed(archive.subarray(0, 10)), Stream.fromEffect(stall)),
    });
    yield* h.installation.start();
    yield* Deferred.await(started);
    yield* TestClock.adjust("45 minutes");
    expect(yield* terminalState(h.installation)).toMatchObject({
      phase: "failed",
      message: "The Codex download timed out. Retry installation.",
    });
    expect(h.downloads()).toBe(1);
    expect(yield* h.fs.readDirectory(h.installation.managedDirectory)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("cancels an in-flight download and cleans the staging directory", () =>
  Effect.gen(function* () {
    const downloading = yield* Deferred.make<void>();
    const body = Stream.fromEffect(
      Deferred.succeed(downloading, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const { installation, fs } = yield* makeHarness({ body });
    const started = yield* installation.start();
    yield* Deferred.await(downloading);
    expect((yield* installation.cancel(started.operationId!)).phase).toBe("cancelled");
    expect(
      (yield* fs.readDirectory(installation.managedDirectory)).filter((name) =>
        name.startsWith(".install-"),
      ),
    ).toEqual([]);
    expect(yield* fs.exists(`${installation.managedDirectory}/active.json`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("protects active process leases and removes the runtime after release", () =>
  Effect.gen(function* () {
    const { installation, fs } = yield* makeHarness();
    yield* installation.start();
    yield* terminalState(installation);
    const leaseScope = yield* Scope.make();
    yield* installation.acquire().pipe(Effect.provideService(Scope.Scope, leaseScope));
    expect((yield* Effect.flip(installation.remove())).detail).toContain("Stop Codex sessions");
    yield* Scope.close(leaseScope, Exit.void);
    yield* installation.remove();
    expect(yield* fs.exists(installation.managedDirectory)).toBe(false);
    expect((yield* installation.state).installedVersion).toBeNull();
    expect((yield* installation.state).executablePath).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("keeps an activated runtime when a later update fails verification", () =>
  Effect.gen(function* () {
    const first = yield* makeHarness();
    yield* first.installation.start();
    yield* terminalState(first.installation);
    const update = yield* makeHarness({
      baseDir: first.baseDir,
      options: { releaseAsset: { ...asset, version: "0.156.2", sha256: "0".repeat(64) } },
    });
    expect((yield* update.installation.state).executablePath).toBe(
      (yield* first.installation.resolve()).executablePath,
    );
    yield* update.installation.start();
    expect((yield* terminalState(update.installation)).phase).toBe("failed");
    expect((yield* update.installation.resolve()).version).toBe("0.156.1");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

const releaseMetadata = (version: string, sha256 = "a".repeat(64)) => ({
  tag_name: `rust-v${version}`,
  draft: false,
  prerelease: false,
  assets: [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-musl",
    "x86_64-unknown-linux-musl",
    "aarch64-pc-windows-msvc",
    "x86_64-pc-windows-msvc",
  ].map((target) => ({
    name: `codex-package-${target}.tar.gz`,
    size: archive.length,
    digest: `sha256:${sha256}`,
    browser_download_url: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-package-${target}.tar.gz`,
  })),
});

it("selects complete verified packages for all supported platforms", () => {
  for (const platform of ["darwin", "linux", "win32"] as const)
    for (const arch of ["x64", "arm64"])
      expect(
        CodexInstallation.resolveCodexReleaseAsset(platform, arch, releaseMetadata("0.200.0")),
      ).toMatchObject({ version: "0.200.0", sha256: "a".repeat(64) });
  expect(
    CodexInstallation.resolveCodexReleaseAsset("linux", "riscv64", releaseMetadata("0.200.0")),
  ).toBeNull();
});

it("rejects prereleases and packages with missing or invalid integrity metadata", () => {
  const release = releaseMetadata("0.200.0");
  for (const invalid of [
    { ...release, prerelease: true },
    { ...release, draft: true },
    { ...release, tag_name: "rust-v0.201.0-alpha.1" },
    { ...release, assets: [] },
    ...[null, "sha256:bad"].map((digest) => ({
      ...release,
      assets: release.assets.map((asset) => ({ ...asset, digest })),
    })),
    {
      ...release,
      assets: release.assets.map((asset) => ({
        ...asset,
        browser_download_url: "https://example.com/package.tar.gz",
      })),
    },
  ])
    expect(CodexInstallation.resolveCodexReleaseAsset("darwin", "arm64", invalid)).toBeNull();
});

it.effect("discovers and installs the latest package without a pinned version", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ options: { releaseAsset: undefined } });
    expect((yield* h.installation.state).version).toBeNull();
    yield* h.installation.refresh();
    expect((yield* h.installation.state).version).toBe(asset.version);
    expect(h.downloads()).toBe(0);
    yield* h.installation.start();
    expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
    expect(h.releaseChecks()).toBe(1);
    expect(h.downloads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("starts from a cached verified release when GitHub later rate-limits metadata", () =>
  Effect.gen(function* () {
    let rateLimited = false;
    const h = yield* makeHarness({
      options: { releaseAsset: undefined },
      releaseResponse: () =>
        rateLimited
          ? Response.json(
              { message: "API rate limit exceeded" },
              {
                status: 403,
                headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" },
              },
            )
          : undefined,
    });
    yield* h.installation.refresh();
    rateLimited = true;

    yield* h.installation.start();
    const terminal = yield* terminalState(h.installation);
    expect(terminal).toMatchObject({
      phase: "succeeded",
      version: asset.version,
      installedVersion: asset.version,
      source: "managed",
      canRemove: true,
      message: null,
    });
    expect(h.releaseChecks()).toBe(1);
    expect(h.downloads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("reports a rate limit when no verified release is cached", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      options: { releaseAsset: undefined },
      releaseResponse: () =>
        Response.json(
          { message: "API rate limit exceeded" },
          {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" },
          },
        ),
    });

    const failure = yield* Effect.flip(h.installation.start());
    expect(failure.detail.toLowerCase()).toContain("rate limit");
    expect(failure.detail).toContain("GitHub");
    expect(h.releaseChecks()).toBe(1);
    expect(h.downloads()).toBe(0);
    expect((yield* h.installation.state).phase).toBe("idle");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("coalesces concurrent failed release checks during the failure cooldown", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      options: { releaseAsset: undefined },
      releaseResponse: () =>
        Response.json(
          { message: "API rate limit exceeded" },
          {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" },
          },
        ),
    });

    const results = yield* Effect.all(
      [
        h.installation.refresh({ fresh: true }).pipe(Effect.exit),
        h.installation.refresh({ fresh: true }).pipe(Effect.exit),
      ],
      { concurrency: 2 },
    );
    expect(results.every(Exit.isFailure)).toBe(true);
    expect(h.releaseChecks()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each([
  { githubToken: "test-github-token", authorization: "Bearer test-github-token" },
  { githubToken: undefined, authorization: undefined },
])("uses GitHub credentials only for release metadata (%s)", ({ githubToken, authorization }) =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      options: { releaseAsset: undefined },
      ...(githubToken === undefined ? {} : { githubToken }),
    });
    yield* h.installation.start();
    yield* terminalState(h.installation);

    expect(h.requests()).toContainEqual({
      url: "https://api.github.com/repos/openai/codex/releases/latest",
      authorization,
    });
    const assetRequests = h
      .requests()
      .filter((request) => request.url.includes("/releases/download/"));
    expect(assetRequests).toHaveLength(1);
    expect(assetRequests[0]?.authorization).toBeUndefined();
    expect(h.releaseChecks()).toBe(1);
    expect(h.downloads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("honors GitHub retry headers during fresh refreshes", () =>
  Effect.gen(function* () {
    let rateLimited = true;
    const h = yield* makeHarness({
      options: { releaseAsset: undefined },
      releaseResponse: () =>
        rateLimited
          ? Response.json(
              { message: "API rate limit exceeded" },
              {
                status: 403,
                headers: {
                  "x-ratelimit-remaining": "0",
                  "x-ratelimit-reset": "60",
                  "retry-after": "30",
                },
              },
            )
          : releaseMetadata(asset.version),
    });

    const initialFailure = yield* Effect.flip(h.installation.refresh());
    expect(initialFailure.detail.toLowerCase()).toContain("rate limit");
    expect((yield* Effect.flip(h.installation.refresh({ fresh: true }))).detail).toBe(
      initialFailure.detail,
    );
    yield* TestClock.adjust("30 seconds");
    expect((yield* Effect.flip(h.installation.refresh({ fresh: true }))).detail).toBe(
      initialFailure.detail,
    );
    expect(h.releaseChecks()).toBe(1);

    yield* TestClock.adjust("30 seconds");
    rateLimited = false;
    yield* h.installation.refresh({ fresh: true });
    expect((yield* h.installation.state).version).toBe(asset.version);
    expect(h.releaseChecks()).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("retries a rate-limited discovery immediately when GitHub credentials change", () =>
  Effect.gen(function* () {
    let githubToken: string | undefined;
    let rateLimited = true;
    const h = yield* makeHarness({
      options: { releaseAsset: undefined },
      githubCredential: () => githubToken,
      releaseResponse: () =>
        rateLimited
          ? Response.json(
              { message: "API rate limit exceeded" },
              {
                status: 403,
                headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3600" },
              },
            )
          : releaseMetadata(asset.version),
    });

    expect((yield* Effect.flip(h.installation.refresh({ fresh: true }))).detail).toContain(
      "rate-limited",
    );
    githubToken = "new-github-token";
    rateLimited = false;
    yield* h.installation.refresh({ fresh: true });

    expect(h.releaseChecks()).toBe(2);
    expect(
      h
        .requests()
        .filter(
          (request) => request.url === "https://api.github.com/repos/openai/codex/releases/latest",
        )
        .map((request) => request.authorization),
    ).toEqual([undefined, "Bearer new-github-token"]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("retries rejected GitHub credentials anonymously and remembers the rejection", () =>
  Effect.gen(function* () {
    let metadataResponses = 0;
    const h = yield* makeHarness({
      options: { releaseAsset: undefined },
      githubToken: "rejected-github-token",
      releaseResponse: () => {
        metadataResponses++;
        if (metadataResponses === 1)
          return Response.json({ message: "Bad credentials" }, { status: 401 });
        if (metadataResponses === 2)
          return Response.json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" },
            },
          );
        return undefined;
      },
    });

    const failure = yield* Effect.flip(h.installation.refresh({ fresh: true }));
    expect(failure.detail).toContain("rate-limited");
    expect(h.releaseChecks()).toBe(2);
    expect(h.credentialInvalidations()).toBe(1);
    expect(h.requests().map((request) => request.authorization)).toEqual([
      "Bearer rejected-github-token",
      undefined,
    ]);

    expect((yield* Effect.flip(h.installation.refresh({ fresh: true }))).detail).toBe(
      failure.detail,
    );
    expect(h.releaseChecks()).toBe(2);
    yield* TestClock.adjust("60 seconds");
    yield* h.installation.refresh({ fresh: true });
    expect(h.releaseChecks()).toBe(3);
    expect(h.credentialInvalidations()).toBe(1);
    expect(h.requests().map((request) => request.authorization)).toEqual([
      "Bearer rejected-github-token",
      undefined,
      undefined,
    ]);

    yield* h.installation.start();
    expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
    const assetRequests = h
      .requests()
      .filter((request) => request.url.includes("/releases/download/"));
    expect(assetRequests).toHaveLength(1);
    expect(assetRequests[0]?.authorization).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("briefly caches non-rate-limit discovery failures", () =>
  Effect.gen(function* () {
    let unavailable = true;
    const h = yield* makeHarness({
      options: { releaseAsset: undefined },
      releaseResponse: () =>
        unavailable
          ? Response.json({ message: "temporarily unavailable" }, { status: 503 })
          : releaseMetadata(asset.version),
    });

    const initialFailure = yield* Effect.flip(h.installation.refresh());
    expect((yield* Effect.flip(h.installation.refresh({ fresh: true }))).detail).toBe(
      initialFailure.detail,
    );
    yield* TestClock.adjust("29 seconds");
    expect((yield* Effect.flip(h.installation.refresh({ fresh: true }))).detail).toBe(
      initialFailure.detail,
    );
    expect(h.releaseChecks()).toBe(1);

    yield* TestClock.adjust("1 second");
    unavailable = false;
    yield* h.installation.refresh({ fresh: true });
    expect((yield* h.installation.state).version).toBe(asset.version);
    expect(h.releaseChecks()).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("manual refresh discovers newer releases while background checks reuse the cache", () =>
  Effect.gen(function* () {
    let version = "0.163.0";
    const h = yield* makeHarness({
      options: { releaseAsset: undefined },
      releaseResponse: () => releaseMetadata(version),
    });
    yield* h.installation.refresh();
    version = "0.164.0";
    yield* h.installation.refresh();
    expect((yield* h.installation.state).version).toBe("0.163.0");
    yield* h.installation.refresh({ fresh: true });
    expect((yield* h.installation.state).version).toBe("0.164.0");
    expect(h.releaseChecks()).toBe(2);
    expect(h.downloads()).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("failed discovery preserves the installed runtime and never downloads a fallback", () =>
  Effect.gen(function* () {
    const first = yield* makeHarness();
    yield* first.installation.start();
    yield* terminalState(first.installation);
    const h = yield* makeHarness({
      baseDir: first.baseDir,
      options: { releaseAsset: undefined },
      releaseResponse: () => ({ error: "unavailable" }),
    });
    expect(Exit.isFailure(yield* Effect.exit(h.installation.start()))).toBe(true);
    expect((yield* h.installation.resolve()).version).toBe(asset.version);
    expect(h.downloads()).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
it.effect(
  "does not downgrade an installed runtime when the release endpoint reports an older version",
  () =>
    Effect.gen(function* () {
      const first = yield* makeHarness();
      yield* first.installation.start();
      yield* terminalState(first.installation);
      const h = yield* makeHarness({
        baseDir: first.baseDir,
        options: { releaseAsset: undefined },
        releaseResponse: () => releaseMetadata("0.155.0"),
      });
      yield* h.installation.start();
      expect((yield* h.installation.resolve()).version).toBe(asset.version);
      expect(h.downloads()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

// Stands in for Windows' bsdtar: CRLF listings, and extraction writes the Windows layout.
