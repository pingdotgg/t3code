import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { enrichProviderSnapshotWithVersionAdvisory } from "@t3tools/provider-core/server/maintenanceResolver";
import { fetchLatestFxVersion, makeFxMaintenance } from "./maintenance.ts";

const snapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("fx"),
  driver: ProviderDriverKind.make("fx"),
  enabled: true,
  installed: true,
  version: "0.0.13",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-29T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
};

const serving = (response: Response) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response)));

const maintenanceLayer = Layer.merge(
  NodeServices.layer,
  Layer.succeed(HostProcess.KernelRelease, "24.0.0"),
);

it.layer(maintenanceLayer)("fx maintenance", (it) => {
  it.effect("uses the owning Homebrew installation and otherwise stays manual-only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const prefix = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-fx-brew-" })
        .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
      const brewPath = path.join(prefix, "bin", "brew");
      yield* fs.makeDirectory(path.dirname(brewPath), { recursive: true });
      yield* fs.writeFileString(brewPath, "");
      let reportedPrefix = prefix;
      const spawner = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return Effect.die("Expected a brew probe");
        const output =
          command.args[0] === "--prefix"
            ? reportedPrefix
            : JSON.stringify({ formulae: [{ versions: { stable: "0.0.14" } }] });
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(output)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });
      const context = {
        binaryPath: path.join(prefix, "bin", "fx"),
        resolvedCommandPath: path.join(prefix, "bin", "fx"),
        realCommandPath: path.join(prefix, "Cellar", "fx-agent", "0.0.13", "bin", "fx"),
        platform: "darwin" as const,
        env: { PATH: "" },
      };
      const resolver = makeFxMaintenance(Effect.die("Homebrew must not use fx's release channel"));
      const capabilities = yield* resolver
        .resolve(context)
        .pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcess.Platform, "darwin"),
        );
      expect(capabilities.update).toMatchObject({
        executable: brewPath,
        args: ["upgrade", "fx-agent"],
        lockKey: "homebrew",
      });
      expect(yield* capabilities.lookupLatestVersion!).toBe("0.0.14");

      reportedPrefix = path.join(prefix, "another-installation");
      expect(
        (yield* resolver
          .resolve(context)
          .pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(HostProcess.Platform, "darwin"),
          )).update,
      ).toBeNull();
      yield* fs.remove(brewPath);
      expect((yield* resolver.resolve(context)).update).toBeNull();
      expect(
        (yield* resolver.resolve({
          ...context,
          realCommandPath: path.join(prefix, "Cellar", "mise", "1.0.0", "bin", "fx"),
        })).update,
      ).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("offers `fx upgrade` on the instance's own binary once a newer release is out", () =>
    Effect.gen(function* () {
      const binaryPath = "/opt/tools/custom fx";
      const capabilities = yield* makeFxMaintenance(
        fetchLatestFxVersion().pipe(
          Effect.provideService(HttpClient.HttpClient, serving(new Response("v0.0.15\n"))),
        ),
      ).resolve({
        binaryPath,
        resolvedCommandPath: binaryPath,
        realCommandPath: "/opt/tools/fx-real",
        platform: "darwin",
        env: { HOME: "/home/fx" },
      });
      expect(capabilities.update).toMatchObject({
        executable: binaryPath,
        args: ["upgrade"],
        command: `'${binaryPath}' upgrade`,
        lockKey: "fx:/opt/tools/fx-real",
        env: { HOME: "/home/fx" },
      });

      const enriched = yield* enrichProviderSnapshotWithVersionAdvisory(snapshot, capabilities, {
        enableProviderUpdateChecks: true,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, serving(new Response("unused"))),
        Effect.provide(ProviderLatestVersions.layer),
      );
      expect(enriched.versionAdvisory).toMatchObject({
        status: "behind_latest",
        currentVersion: "0.0.13",
        latestVersion: "0.0.15",
        canUpdate: true,
        updateCommand: `'${binaryPath}' upgrade`,
      });

      const resolver = makeFxMaintenance(Effect.succeed("0.0.15"));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-mise-" });
      const wrapperPath = path.join(directory, "fx");
      for (const { managedPath, env } of [
        { managedPath: "/home/fx/.local/share/mise/installs/fx/0.0.15/bin/fx", env: {} },
        { managedPath: "/home/fx/.local/share/mise/shims/fx", env: {} },
        { managedPath: "/home/fx/.local/share/mise/command-wrappers/fx", env: {} },
        {
          managedPath: "/opt/tools/installs/fx/0.0.15/bin/fx",
          env: { MISE_DATA_DIR: "/opt/tools/" },
        },
        {
          managedPath: "/opt/versions/fx/0.0.15/bin/fx",
          env: { MISE_INSTALLS_DIR: "/opt/versions" },
        },
        {
          managedPath: "/opt/store/fx-abc/bin/fx",
          env: { MISE_INSTALL_STORE_DIR: "/opt/store" },
        },
        {
          managedPath: "/opt/system/installs/fx/0.0.15/bin/fx",
          env: { MISE_SYSTEM_DATA_DIR: "/opt/system" },
        },
        {
          managedPath: "/opt/system-installs/fx/0.0.15/bin/fx",
          env: { MISE_SYSTEM_INSTALLS_DIR: "/opt/system-installs" },
        },
      ]) {
        for (const paths of [
          { resolvedCommandPath: managedPath, realCommandPath: binaryPath },
          { resolvedCommandPath: binaryPath, realCommandPath: managedPath },
        ]) {
          const managed = yield* resolver.resolve({
            binaryPath,
            ...paths,
            platform: "linux",
            env,
          });
          expect(managed.update).toBeNull();
          const managedSnapshot = yield* enrichProviderSnapshotWithVersionAdvisory(
            snapshot,
            managed,
            {
              enableProviderUpdateChecks: true,
            },
          ).pipe(
            Effect.provideService(HttpClient.HttpClient, serving(new Response("unused"))),
            Effect.provide(ProviderLatestVersions.layer),
          );
          expect(managedSnapshot.versionAdvisory).toMatchObject({
            status: "behind_latest",
            latestVersion: "0.0.15",
            canUpdate: false,
          });
          expect(managed.installPath).toBe(paths.realCommandPath);
        }
      }
      for (const command of ["x", "exec"]) {
        yield* fs.writeFileString(wrapperPath, `#!/bin/sh\nexec mise ${command} -- fx "$@"\n`);
        const managed = yield* resolver.resolve({
          binaryPath: wrapperPath,
          resolvedCommandPath: wrapperPath,
          realCommandPath: wrapperPath,
          platform: "linux",
          env: { MISE_SHIMS_DIR: directory, MISE_SYSTEM_SHIMS_DIR: directory },
        });
        expect(managed.update).toBeNull();
        expect(managed.installPath).toBe(wrapperPath);
        expect(yield* managed.lookupLatestVersion!).toBe("0.0.15");
      }
      yield* fs.writeFileString(wrapperPath, "#!/bin/sh\nexit 0\n");
      expect(
        (yield* resolver.resolve({
          binaryPath: wrapperPath,
          resolvedCommandPath: wrapperPath,
          realCommandPath: wrapperPath,
          platform: "linux",
          env: { MISE_SHIMS_DIR: directory, MISE_SYSTEM_SHIMS_DIR: directory },
        })).update,
      ).not.toBeNull();
      const outsideMise = "/opt/tools-extra/installs/fx/0.0.15/bin/fx";
      expect(
        (yield* resolver.resolve({
          binaryPath: outsideMise,
          resolvedCommandPath: outsideMise,
          realCommandPath: outsideMise,
          platform: "linux",
          env: { MISE_DATA_DIR: "/opt/tools" },
        })).update,
      ).not.toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the latest version unknown when the release file is unusable", () =>
    Effect.gen(function* () {
      for (const response of [
        new Response("<html>not found</html>"),
        new Response("v0.0.15", { status: 503 }),
      ]) {
        const latest = yield* fetchLatestFxVersion().pipe(
          Effect.provideService(HttpClient.HttpClient, serving(response)),
        );
        expect(latest).toBeNull();
      }
      expect((yield* makeFxMaintenance(Effect.succeed("0.0.15")).resolve(null)).update).toBeNull();
    }),
  );

  it.effect("offers no update or latest version on macOS 14, which newer fx cannot run on", () =>
    Effect.gen(function* () {
      const binaryPath = "/opt/tools/fx";
      const capabilities = yield* makeFxMaintenance(Effect.succeed("0.0.15"))
        .resolve({
          binaryPath,
          resolvedCommandPath: binaryPath,
          realCommandPath: binaryPath,
          platform: "darwin",
          env: {},
        })
        .pipe(Effect.provideService(HostProcess.KernelRelease, "23.6.0"));
      expect(capabilities.update).toBeNull();
      expect(capabilities.lookupLatestVersion).toBeUndefined();
    }),
  );
});
