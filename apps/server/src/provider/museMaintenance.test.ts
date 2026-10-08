import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  compareMuseVersions,
  enrichMuseSnapshot,
  museMaintenance,
  latestMuseVersion,
  parseMuseVersion,
} from "./museMaintenance.ts";
import {
  ProviderVersionCache,
  makeManualOnlyProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";

const maintenanceCapabilities = {
  ...makeManualOnlyProviderMaintenanceCapabilities({
    provider: ProviderDriverKind.make("muse"),
    packageName: null,
  }),
  compareVersions: compareMuseVersions,
};
const snapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("muse"),
  driver: ProviderDriverKind.make("muse"),
  enabled: true,
  installed: true,
  version: "1.0.3",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-09-10T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
};

it.layer(NodeServices.layer)("Muse maintenance", (it) => {
  it.effect(
    "refreshes a cached channel failure when an explicit update requests verification",
    () =>
      Effect.gen(function* () {
        let requests = 0;
        const check = Effect.gen(function* () {
          expect(yield* latestMuseVersion({})).toBeNull();
          expect(yield* latestMuseVersion({})).toBeNull();
          expect(yield* latestMuseVersion({}, { fresh: true })).toBe("1.1.1-R10.1");
        });
        yield* check.pipe(
          Effect.provideService(ProviderVersionCache, new Map()),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              requests += 1;
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  requests === 1
                    ? new Response("unavailable", { status: 503 })
                    : Response.json({ version: "1.1.1-R10.1" }),
                ),
              );
            }),
          ),
        );
        expect(requests).toBe(2);
      }),
  );
  it.effect(
    "compares numeric native release revisions and preserves the CLI release identity",
    () =>
      Effect.sync(() => {
        expect(parseMuseVersion("Muse Code 1.1.1 (1.1.1-R2514.1)")).toBe("1.1.1-R2514.1");
        expect(compareMuseVersions("1.1.1-R9.1", "1.1.1-R10.1")).toBeLessThan(0);
        expect(compareMuseVersions("1.1.1-R2514.1", "1.1.1-R2514.2")).toBeLessThan(0);
        expect(compareMuseVersions("1.2.0-R1.1", "1.1.1-R2514.2")).toBeGreaterThan(0);
        // A CLI that prints no revision compares by release, never as an older prerelease.
        expect(compareMuseVersions("1.4.3", "1.4.3-R5018.1")).toBe(0);
        expect(compareMuseVersions("1.4.2", "1.4.3-R5018.1")).toBeLessThan(0);
      }),
  );
  it.effect(
    "finds releases from the instance's channel and caches the native version, not the SDK version",
    () =>
      Effect.gen(function* () {
        const requests: string[] = [];
        const httpClient = HttpClient.make((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ version: "1.1.1-R2514.1" })),
          );
        });
        const check = enrichMuseSnapshot({
          snapshot,
          maintenanceCapabilities,
          enableProviderUpdateChecks: true,
          environment: { MUSE_CHANNEL: "muse-canary" },
        });
        const [first, second] = yield* Effect.all([check, check], { concurrency: 1 }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderVersionCache, new Map()),
        );
        expect(first.versionAdvisory).toMatchObject({
          status: "behind_latest",
          currentVersion: "1.0.3",
          latestVersion: "1.1.1-R2514.1",
          canUpdate: false,
        });
        expect(second.versionAdvisory?.latestVersion).toBe("1.1.1-R2514.1");
        expect(requests).toEqual(["https://api.meta.ai/muse-code/channels/muse-canary"]);
      }),
  );

  it.effect("reports native release R9 behind R10 and R10 current against R9", () =>
    Effect.gen(function* () {
      for (const [current, latest, status] of [
        ["1.4.2-R9.1", "1.4.2-R10.1", "behind_latest"],
        ["1.4.2-R10.1", "1.4.2-R9.1", "current"],
      ] as const) {
        const result = yield* enrichMuseSnapshot({
          snapshot: { ...snapshot, version: current },
          maintenanceCapabilities,
          enableProviderUpdateChecks: true,
          environment: {},
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, Response.json({ version: latest })),
              ),
            ),
          ),
          Effect.provideService(ProviderVersionCache, new Map()),
        );
        expect(result.versionAdvisory?.status).toBe(status);
      }
    }),
  );

  it.effect("skips network checks when disabled, uninstalled or disabled in settings", () =>
    Effect.gen(function* () {
      for (const input of [
        { snapshot, enableProviderUpdateChecks: false },
        { snapshot: { ...snapshot, enabled: false }, enableProviderUpdateChecks: true },
        { snapshot: { ...snapshot, installed: false }, enableProviderUpdateChecks: true },
      ]) {
        const result = yield* enrichMuseSnapshot({
          ...input,
          maintenanceCapabilities,
          environment: {},
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Unexpected release request")),
          ),
        );
        expect(result.versionAdvisory?.status).toBe("unknown");
      }
    }),
  );

  it.effect("tolerates invalid release manifests and unavailable channels", () =>
    Effect.gen(function* () {
      for (const response of [
        Response.json({ version: 12 }),
        Response.json({ version: "1.1.1" }),
        new Response("unavailable", { status: 503 }),
      ]) {
        const result = yield* enrichMuseSnapshot({
          snapshot,
          maintenanceCapabilities,
          enableProviderUpdateChecks: true,
          environment: {},
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, response)),
            ),
          ),
          Effect.provideService(ProviderVersionCache, new Map()),
        );
        expect(result.status).toBe("ready");
        expect(result.versionAdvisory?.status).toBe("unknown");
      }
    }),
  );

  it.effect("updates only a recognized launcher at the resolved instance path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-maintenance-" });
        const binaryPath = `${directory}/custom muse`;
        const context = {
          binaryPath,
          resolvedCommandPath: binaryPath,
          realCommandPath: binaryPath,
          platform: "linux" as const,
          env: { MUSE_CHANNEL: "muse-canary" },
        };
        yield* fs.writeFileString(
          binaryPath,
          "#!/bin/bash\n# muse-code/launcher-2\n# MUSE_SYNC_UPDATE\n",
        );
        const result = yield* museMaintenance.resolve(context);
        expect(result.update).toMatchObject({
          executable: binaryPath,
          args: ["--version"],
          lockKey: `muse:${binaryPath}`,
          env: {
            MUSE_CHANNEL: "muse-canary",
            MUSE_NO_AUTO_UPDATE: "0",
            MUSE_SYNC_UPDATE: "1",
            MUSE_UPDATE_INTERVAL_SECONDS: "0",
          },
        });
        expect(result.update?.command).toBe(
          `MUSE_CHANNEL=muse-canary MUSE_NO_AUTO_UPDATE=0 MUSE_SYNC_UPDATE=1 MUSE_UPDATE_INTERVAL_SECONDS=0 '${binaryPath}' --version`,
        );
        expect(result.compareVersions).toBe(compareMuseVersions);
        yield* fs.writeFileString(binaryPath, "standalone binary");
        expect((yield* museMaintenance.resolve(context)).update).toBeNull();
        expect((yield* museMaintenance.resolve(null)).update).toBeNull();
      }),
    ),
  );
});
