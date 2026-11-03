import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  invalidateLatestProviderVersion,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeClaudeMaintenanceResolution } from "./ClaudeMaintenance.ts";

const snapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.314",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-31T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const fixture = Effect.fn("ClaudeMaintenance.test.fixture")(function* (
  npm = false,
  platform: NodeJS.Platform = "linux",
  programFiles?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  const binaryPath = npm
    ? path.join(directory, "lib/node_modules/@anthropic-ai/claude-code/cli.js")
    : path.join(directory, ".local/bin", platform === "win32" ? "claude.exe" : "claude");
  yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
  yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
  yield* fs.chmod(binaryPath, 0o755);
  const configDirectory = path.join(directory, "config");
  yield* fs.makeDirectory(configDirectory);
  const settingsPath = path.join(configDirectory, "settings.json");
  const managed = new Map<string, string>();
  const managedDirectory =
    platform === "win32"
      ? `${programFiles ?? "C:/Program Files"}/ClaudeCode`
      : platform === "darwin"
        ? "/Library/Application Support/ClaudeCode"
        : "/etc/claude-code";
  let installationReads = 0;
  const testFs = FileSystem.makeNoop({
    ...fs,
    realPath: (file) => {
      if (file === binaryPath) installationReads++;
      return fs.realPath(file);
    },
    readFileString: (file, ...args) =>
      file.replaceAll("\\", "/").startsWith(`${managedDirectory}/`)
        ? managed.has(file.replaceAll("\\", "/"))
          ? Effect.succeed(managed.get(file.replaceAll("\\", "/"))!)
          : fs.readFileString(path.join(directory, "missing"))
        : fs.readFileString(file, ...args),
    readDirectory: (file) =>
      file.replaceAll("\\", "/") === `${managedDirectory}/managed-settings.d`
        ? Effect.succeed(
            [...managed.keys()]
              .filter((key) => key.includes("/managed-settings.d/"))
              .map((key) => path.basename(key)),
          )
        : fs.readDirectory(file),
  });
  return {
    directory,
    fs,
    managed,
    managedDirectory,
    settingsPath,
    installationReads: () => installationReads,
    makeResolution: makeClaudeMaintenanceResolution({ binaryPath, env: { PATH: "" } }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("version checks must not run a subprocess")),
      ),
      Effect.provideService(FileSystem.FileSystem, testFs),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Environment, {
        PATH: "",
        CLAUDE_CONFIG_DIR: configDirectory,
        ...(programFiles ? { PROGRAMFILES: programFiles } : {}),
      }),
    ),
  };
});

it.layer(NodeServices.layer)("ClaudeMaintenance", (it) => {
  it.effect.each([
    {
      name: "default native channel",
      settings: undefined,
      channel: "latest",
      body: "2.1.314\n",
      status: 200,
      expected: "2.1.314",
      advisory: "current",
      npm: false,
    },
    {
      name: "explicit latest channel",
      settings: '{"autoUpdatesChannel":"latest"}',
      channel: "latest",
      body: "2.1.314",
      status: 200,
      expected: "2.1.314",
      advisory: "current",
      npm: false,
    },
    {
      name: "stable channel",
      settings: '{"autoUpdatesChannel":"stable"}',
      channel: "stable",
      body: "2.1.308",
      status: 200,
      expected: "2.1.308",
      advisory: "current",
      npm: false,
    },
    {
      name: "new native release",
      settings: undefined,
      channel: "latest",
      body: "2.1.315",
      status: 200,
      expected: "2.1.315",
      advisory: "behind_latest",
      npm: false,
    },
    {
      name: "unavailable feed",
      settings: undefined,
      channel: "latest",
      body: "Unavailable",
      status: 503,
      expected: null,
      advisory: "unknown",
      npm: false,
    },
    {
      name: "malformed feed",
      settings: undefined,
      channel: "latest",
      body: "<html>error</html>",
      status: 200,
      expected: null,
      advisory: "unknown",
      npm: false,
    },
    {
      name: "empty feed",
      settings: undefined,
      channel: "latest",
      body: "  ",
      status: 200,
      expected: null,
      advisory: "unknown",
      npm: false,
    },
    {
      name: "npm install",
      settings: '{"autoUpdatesChannel":"stable"}',
      channel: "latest",
      body: "",
      status: 200,
      expected: "2.1.316",
      advisory: "behind_latest",
      npm: true,
    },
  ])("advertises the installable version for $name", (row) =>
    Effect.gen(function* () {
      const f = yield* fixture(row.npm);
      if (row.settings) yield* f.fs.writeFileString(f.settingsPath, row.settings);
      const requests: string[] = [];
      const client = HttpClient.make((request) => {
        requests.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.url.includes("claude-code-releases/")
              ? new Response(row.body, { status: row.status })
              : Response.json({ version: "2.1.316" }),
          ),
        );
      });
      const resolve = yield* f.makeResolution.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const maintenance = yield* resolve();
      const versions = yield* ProviderLatestVersions.make();
      const enrich = enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenance).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, versions),
      );
      expect((yield* enrich).versionAdvisory).toMatchObject({
        status: row.advisory,
        latestVersion: row.expected,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatch(
        row.npm ? /registry\.npmjs\.org/ : new RegExp(`claude-code-releases/${row.channel}$`),
      );
      yield* enrich;
      expect(requests).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "Linux", platform: "linux", programFiles: undefined },
    { name: "macOS", platform: "darwin", programFiles: undefined },
    { name: "Windows default path", platform: "win32", programFiles: undefined },
    { name: "Windows custom path", platform: "win32", programFiles: "D:/Programs" },
  ] as const)(
    "separates channel caches and honors $name managed overrides and feed invalidation",
    (row) =>
      Effect.gen(function* () {
        const f = yield* fixture(false, row.platform, row.programFiles);
        const requests: string[] = [];
        const client = HttpClient.make((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(request.url.endsWith("/stable") ? "2.1.308" : "2.1.314"),
            ),
          );
        });
        const versions = yield* ProviderLatestVersions.make();
        const resolve = yield* f.makeResolution.pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        const check = Effect.gen(function* () {
          const capabilities = yield* resolve();
          return yield* enrichProviderSnapshotWithVersionAdvisory(snapshot, capabilities);
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, versions),
        );
        expect((yield* check).versionAdvisory?.latestVersion).toBe("2.1.314");
        yield* f.fs.writeFileString(f.settingsPath, '{"autoUpdatesChannel":"stable"}');
        expect((yield* check).versionAdvisory?.latestVersion).toBe("2.1.308");
        f.managed.set(
          `${f.managedDirectory}/managed-settings.json`,
          '{"autoUpdatesChannel":"latest"}',
        );
        expect((yield* check).versionAdvisory?.latestVersion).toBe("2.1.314");
        f.managed.set(
          `${f.managedDirectory}/managed-settings.d/20-channel.json`,
          '{"autoUpdatesChannel":"stable"}',
        );
        f.managed.set(
          `${f.managedDirectory}/managed-settings.d/10-channel.json`,
          '{"autoUpdatesChannel":"latest"}',
        );
        expect((yield* check).versionAdvisory?.latestVersion).toBe("2.1.308");
        expect(requests).toHaveLength(2);
        const capabilities = yield* resolve();
        yield* invalidateLatestProviderVersion(capabilities).pipe(
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, versions),
        );
        yield* check;
        expect(requests).toHaveLength(3);
      }).pipe(Effect.scoped),
  );

  it.effect("automatic refresh rereads the native channel while preserving both caches", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const requests: string[] = [];
      const client = HttpClient.make((request) => {
        requests.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(request.url.endsWith("/stable") ? "2.1.308" : "2.1.315"),
          ),
        );
      });
      const resolveMaintenance = yield* f.makeResolution.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const versions = yield* ProviderLatestVersions.make();
      const publications = yield* Queue.unbounded<ServerProvider>();
      yield* makeManagedServerProvider({
        resolveMaintenance,
        getSettings: Effect.succeed({ enabled: true }),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        initialSnapshot: () => Effect.succeed(snapshot),
        checkProvider: Effect.succeed(snapshot),
        refreshInterval: "1 minute",
        enrichSnapshot: ({ snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenance) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenance),
            ),
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, versions),
            Effect.flatMap((enriched) =>
              publishSnapshot(enriched).pipe(
                Effect.andThen(Queue.offer(publications, enriched)),
                Effect.asVoid,
              ),
            ),
          ),
      }).pipe(
        Effect.provide(
          Layer.mock(ProviderHost.ProviderHost)({
            paths: {
              cwd: f.directory,
              baseDir: f.directory,
              stateDir: f.directory,
              providerStatusCacheDir: f.directory,
              attachmentsDir: f.directory,
            },
            settings: {
              get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
              withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
              changes: Stream.empty,
              subscribe: Effect.succeed(Stream.empty),
            },
            shouldRunBackgroundWork: () => Effect.succeed(true),
            resolveAttachmentPath: () => null,
          }),
        ),
      );
      expect((yield* Queue.take(publications)).versionAdvisory).toMatchObject({
        latestVersion: "2.1.315",
        status: "behind_latest",
      });
      expect(requests).toHaveLength(1);

      for (const channel of ["stable", "stable", "latest"] as const) {
        yield* f.fs.writeFileString(
          f.settingsPath,
          JSON.stringify({ autoUpdatesChannel: channel }),
        );
        yield* TestClock.adjust("1 minute");
        expect((yield* Queue.take(publications)).versionAdvisory).toMatchObject({
          latestVersion: channel === "stable" ? "2.1.308" : "2.1.315",
          status: channel === "stable" ? "current" : "behind_latest",
        });
        expect(requests).toEqual([
          "https://downloads.claude.ai/claude-code-releases/latest",
          "https://downloads.claude.ai/claude-code-releases/stable",
        ]);
        expect(f.installationReads()).toBe(1);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("bounds stalled feed bodies and skips disabled update checks", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let requests = 0;
      const client = HttpClient.make((request) => {
        requests++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(new ReadableStream())),
        );
      });
      const resolve = yield* f.makeResolution.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const capabilities = yield* resolve();
      const enrich = (enabled: boolean) =>
        enrichProviderSnapshotWithVersionAdvisory(snapshot, capabilities, {
          enableProviderUpdateChecks: enabled,
        }).pipe(
          Effect.provide(ProviderLatestVersions.layer),
          Effect.provideService(HttpClient.HttpClient, client),
        );
      expect((yield* enrich(false)).versionAdvisory?.status).toBe("unknown");
      expect(requests).toBe(0);
      const pending = yield* enrich(true).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("4 seconds");
      expect((yield* Fiber.join(pending)).versionAdvisory?.status).toBe("unknown");
      expect(requests).toBe(1);
    }).pipe(Effect.scoped),
  );
});
