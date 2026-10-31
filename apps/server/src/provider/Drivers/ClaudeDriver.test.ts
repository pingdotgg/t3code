// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { enrichProviderSnapshotWithVersionAdvisory } from "@t3tools/provider-core/server/maintenanceResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";

// `claude update` installs from this feed, which trails npm's `latest` tag.
const NATIVE_RELEASES_ORIGIN = "storage.googleapis.com";
const NATIVE_LATEST = "2.1.314";
const NPM_LATEST = "2.1.316";

const releaseFeeds = HttpClient.make((request) => {
  const url = new URL(request.url);
  if (url.hostname === "registry.npmjs.org" && url.pathname.endsWith("/latest")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({ name: "@anthropic-ai/claude-code", version: NPM_LATEST }),
      ),
    );
  }
  if (
    url.hostname === NATIVE_RELEASES_ORIGIN &&
    url.pathname.endsWith("/claude-code-releases/latest")
  ) {
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(`${NATIVE_LATEST}\n`)));
  }
  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })));
});

const layerTest = ProviderHostLive.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-driver-maintenance-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(Layer.mock(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner)({})),
  Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, releaseFeeds)),
  // Keep the host's npm off PATH so `npm view` cannot answer for the registry.
  Layer.provideMerge(Layer.succeed(HostProcess.Environment, { PATH: "" })),
);

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Version advisory resolution must not spawn a process"),
);

it.layer(layerTest)("ClaudeDriver", (it) => {
  it.effect.skipIf(windowsHost)(
    "compares a native install against the release feed `claude update` installs from",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-claude-native-latest-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const versionPath = NodePath.join(
          home,
          ".local",
          "share",
          "claude",
          "versions",
          NATIVE_LATEST,
        );
        const launcherPath = NodePath.join(home, ".local", "bin", "claude");
        yield* fs.makeDirectory(NodePath.dirname(versionPath), { recursive: true });
        yield* fs.writeFileString(versionPath, "#!/bin/sh\n");
        yield* fs.chmod(versionPath, 0o755);
        yield* fs.makeDirectory(NodePath.dirname(launcherPath), { recursive: true });
        yield* fs.symlink(versionPath, launcherPath);

        const instanceId = ProviderInstanceId.make("claude-native");
        const instance = yield* ClaudeDriver.create({
          instanceId,
          displayName: "Claude native",
          enabled: false,
          environment: [],
          config: {
            ...ClaudeDriver.defaultConfig(),
            binaryPath: launcherPath,
            homePath: NodePath.join(home, ".claude"),
          },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));
        const capabilities = yield* instance.snapshot.resolveMaintenance();
        const installed: ServerProvider = {
          instanceId,
          driver: ClaudeDriver.driverKind,
          enabled: true,
          installed: true,
          version: NATIVE_LATEST,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-10-30T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        };

        const { versionAdvisory } = yield* enrichProviderSnapshotWithVersionAdvisory(
          installed,
          capabilities,
        );

        expect(capabilities.update).toMatchObject({
          executable: launcherPath,
          args: ["update"],
        });
        expect(versionAdvisory).toMatchObject({
          status: "current",
          currentVersion: NATIVE_LATEST,
          latestVersion: NATIVE_LATEST,
        });
      }).pipe(Effect.scoped),
  );
});
