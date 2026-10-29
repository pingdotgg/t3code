import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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

it.layer(NodeServices.layer)("fx maintenance", (it) => {
  it.effect("offers `fx upgrade` on the instance's own binary once a newer release is out", () =>
    Effect.gen(function* () {
      const binaryPath = "/opt/tools/custom fx";
      const capabilities = yield* makeFxMaintenance(
        fetchLatestFxVersion().pipe(
          Effect.provideService(HttpClient.HttpClient, serving(new Response("v0.0.15\n"))),
        ),
        "24.0.0",
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
    }),
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
      const capabilities = yield* makeFxMaintenance(Effect.succeed("0.0.15"), "23.6.0").resolve({
        binaryPath,
        resolvedCommandPath: binaryPath,
        realCommandPath: binaryPath,
        platform: "darwin",
        env: {},
      });
      expect(capabilities.update).toBeNull();
      expect(capabilities.lookupLatestVersion).toBeUndefined();
    }),
  );
});
