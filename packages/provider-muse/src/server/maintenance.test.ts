import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  compareMuseVersions,
  enrichMuseSnapshot,
  museMaintenance,
  parseMuseVersion,
} from "./maintenance.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";

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
    "compares numeric native release revisions and preserves the CLI release identity",
    () =>
      Effect.sync(() => {
        expect(parseMuseVersion("Muse Code 1.1.1 (1.1.1-R2514.1)")).toBe("1.1.1-R2514.1");
        expect(compareMuseVersions("1.1.1-R9.1", "1.1.1-R10.1")).toBeLessThan(0);
        expect(compareMuseVersions("1.1.1-R2514.1", "1.1.1-R2514.2")).toBeLessThan(0);
        expect(compareMuseVersions("1.2.0-R1.1", "1.1.1-R2514.2")).toBeGreaterThan(0);
        expect(compareMuseVersions("1.4.3", "1.4.3-R5018.1")).toBe(0);
        expect(compareMuseVersions("1.4.2", "1.4.3-R5018.1")).toBeLessThan(0);
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
          Effect.provide(ProviderLatestVersions.layer),
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

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "updates a mise install through mise and offers the version mise would install",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-mise-" });
          const installPath = `${directory}/mise/installs/muse/1.4.9-R6000.1`;
          const binaryPath = `${installPath}/muse`;
          const misePath = `${directory}/bin/mise`;
          yield* fs.makeDirectory(installPath, { recursive: true });
          yield* fs.makeDirectory(`${directory}/bin`);
          yield* fs.writeFileString(binaryPath, "standalone binary");
          const installed = JSON.stringify({
            muse: [{ install_path: installPath, requested_version: "latest", active: true }],
          });
          yield* fs.writeFileString(
            misePath,
            `#!/bin/sh\ncase "$1" in\n  ls) echo '${installed}' ;;\n  latest) echo 1.4.10-R6427.1 ;;\n  *) exit 1 ;;\nesac\n`,
          );
          yield* fs.chmod(misePath, 0o755);
          const capabilities = yield* museMaintenance.resolve({
            binaryPath,
            resolvedCommandPath: binaryPath,
            realCommandPath: binaryPath,
            platform: "linux",
            env: { PATH: `${directory}/bin` },
          });
          expect(capabilities.update).toMatchObject({
            command: "mise upgrade muse",
            executable: misePath,
            args: ["upgrade", "muse"],
          });
          expect(capabilities.compareVersions).toBe(compareMuseVersions);

          const result = yield* enrichMuseSnapshot({
            snapshot: { ...snapshot, version: "1.4.9-R6000.1" },
            maintenanceCapabilities: capabilities,
            enableProviderUpdateChecks: true,
            environment: {},
          }).pipe(
            Effect.provide(ProviderLatestVersions.layer),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("Unexpected channel request")),
            ),
          );
          expect(result.versionAdvisory).toMatchObject({
            status: "behind_latest",
            latestVersion: "1.4.10-R6427.1",
            canUpdate: true,
          });
        }),
      ),
  );
});
