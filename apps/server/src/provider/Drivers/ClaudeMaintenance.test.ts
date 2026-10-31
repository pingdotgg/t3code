import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  invalidateLatestProviderVersion,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveClaudeMaintenance } from "./ClaudeMaintenance.ts";

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

const fixture = Effect.fn("ClaudeMaintenance.test.fixture")(function* (npm = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  const binaryPath = npm
    ? path.join(directory, "lib/node_modules/@anthropic-ai/claude-code/cli.js")
    : path.join(directory, ".local/bin/claude");
  yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
  yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
  yield* fs.chmod(binaryPath, 0o755);
  const configDirectory = path.join(directory, "config");
  yield* fs.makeDirectory(configDirectory);
  const settingsPath = path.join(configDirectory, "settings.json");
  const managed = new Map<string, string>();
  const testFs = FileSystem.makeNoop({
    ...fs,
    readFileString: (file, ...args) =>
      file.replaceAll("\\", "/").startsWith("/etc/claude-code/")
        ? managed.has(file.replaceAll("\\", "/"))
          ? Effect.succeed(managed.get(file.replaceAll("\\", "/"))!)
          : fs.readFileString(path.join(directory, "missing"))
        : fs.readFileString(file, ...args),
    readDirectory: (file) =>
      file.replaceAll("\\", "/") === "/etc/claude-code/managed-settings.d"
        ? Effect.succeed(
            [...managed.keys()]
              .filter((key) => key.includes("/managed-settings.d/"))
              .map((key) => path.basename(key)),
          )
        : fs.readDirectory(file),
  });
  return {
    fs,
    managed,
    settingsPath,
    resolve: resolveClaudeMaintenance({ binaryPath, env: { PATH: "" } }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("version checks must not run a subprocess")),
      ),
      Effect.provideService(FileSystem.FileSystem, testFs),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, {
        PATH: "",
        CLAUDE_CONFIG_DIR: configDirectory,
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
      const maintenance = yield* f.resolve.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
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

  it.effect("separates channel caches and honors managed overrides and feed invalidation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
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
      const check = Effect.gen(function* () {
        const capabilities = yield* f.resolve;
        return yield* enrichProviderSnapshotWithVersionAdvisory(snapshot, capabilities);
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, versions),
      );
      expect((yield* check).versionAdvisory?.latestVersion).toBe("2.1.314");
      yield* f.fs.writeFileString(f.settingsPath, '{"autoUpdatesChannel":"stable"}');
      expect((yield* check).versionAdvisory?.latestVersion).toBe("2.1.308");
      f.managed.set("/etc/claude-code/managed-settings.json", '{"autoUpdatesChannel":"latest"}');
      expect((yield* check).versionAdvisory?.latestVersion).toBe("2.1.314");
      f.managed.set(
        "/etc/claude-code/managed-settings.d/20-channel.json",
        '{"autoUpdatesChannel":"stable"}',
      );
      f.managed.set(
        "/etc/claude-code/managed-settings.d/10-channel.json",
        '{"autoUpdatesChannel":"latest"}',
      );
      expect((yield* check).versionAdvisory?.latestVersion).toBe("2.1.308");
      expect(requests).toHaveLength(2);
      const capabilities = yield* f.resolve.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      yield* invalidateLatestProviderVersion(capabilities).pipe(
        Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, versions),
      );
      yield* check;
      expect(requests).toHaveLength(3);
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
      const capabilities = yield* f.resolve.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
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
