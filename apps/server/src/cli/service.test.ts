import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Terminal from "effect/Terminal";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import {
  offerServiceDuringOnboarding,
  recoverServiceOnboardingOffer,
  serviceCommand,
} from "./service.ts";

afterEach(() => vi.restoreAllMocks());

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/t3code.service",
  logPath: "/home/me/.t3/userdata/logs/boot-service.log",
} as const;

const newerServiceStatus = { ...status, current: false, installedVersion: "999.0.0" };
const otherHomeStatus = { ...status, current: false, otherBaseDir: "/srv/t3" };
const unknownHomeStatus = { ...status, current: false, unknownBaseDir: true };

function makeTestService(
  serviceStatus: BootService.BootServiceStatus,
  restartOutcome: "restarted" | "queued" = "restarted",
) {
  const installOptions: Array<Parameters<BootService.BootService["Service"]["install"]>[0]> = [];
  const restarts: Array<true> = [];
  const service = BootService.BootService.of({
    status: Effect.succeed(serviceStatus),
    withStopped: (operation) => operation,
    restart: Effect.sync(() => {
      restarts.push(true);
      return serviceStatus.installed ? restartOutcome : "skipped";
    }),
    install: (options) =>
      Effect.sync(() => {
        installOptions.push(options);
        return {
          program: ["/test/t3/runtime/versions/1.0.0/t3", "__service-launcher"],
          baseDir: "/test/t3",
          unitPath: serviceStatus.unitPath,
          logPath: serviceStatus.logPath,
        };
      }),
    uninstall: Effect.succeed(false),
  });
  return { service, installOptions, restarts };
}

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("service commands", (it) => {
  it.effect.each(["install", "update"] as const)(
    "%s refuses a downgrade before changing the service",
    (command) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
        const { service, installOptions } = makeTestService(newerServiceStatus);
        vi.spyOn(BootService, "layer").mockReturnValue(
          Layer.succeed(BootService.BootService, service),
        );

        const error = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
          command,
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
          Effect.flip,
        );

        expect(error).toMatchObject({
          _tag: "BootServiceDowngradeRefusedError",
          installedVersion: "999.0.0",
          targetVersion: packageJson.version,
        });
        expect(installOptions).toEqual([]);
      }),
  );

  it.effect("protect refuses root before creating any T3 directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
      const baseDir = `${parent}/t3`;
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(BootService.BootService, makeTestService(status).service),
      );

      const output = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
        "protect",
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.andThen(TestConsole.logLines),
        Effect.map((lines) => lines.join("\n")),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.UserId, 0),
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );
      expect(output).toContain("without sudo");
      expect(yield* fs.exists(baseDir)).toBe(false);
    }),
  );

  // regression: #13239 a stale nvm-installed CLI reported "already using" its own version
  it.effect.each(["install", "update"] as const)(
    "%s names the CLI that found nothing to change",
    (command) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
        const { service, installOptions } = makeTestService(status);
        vi.spyOn(BootService, "layer").mockReturnValue(
          Layer.succeed(BootService.BootService, service),
        );
        const node = "/home/me/.nvm/versions/node/v26.8.2/bin/node";
        const script = "/home/me/.nvm/versions/node/v26.8.2/lib/node_modules/t3/dist/bin.mjs";

        const output = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
          command,
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.andThen(TestConsole.logLines),
          Effect.map((lines) => lines.join("\n")),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.ExecutablePath, node),
          Effect.provideService(HostProcess.Arguments, [node, script, "service", command]),
          Effect.provide(
            Layer.mergeAll(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
              Layer.fresh(TestConsole.layer),
            ),
          ),
        );
        expect(output).toContain(`t3@${packageJson.version}`);
        expect(output).toContain(script);
        expect(installOptions).toEqual([]);
      }),
  );

  it.effect.each([otherHomeStatus, unknownHomeStatus])(
    "status does not offer to repair a service install would refuse",
    (serviceStatus) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
        vi.spyOn(BootService, "layer").mockReturnValue(
          Layer.succeed(BootService.BootService, makeTestService(serviceStatus).service),
        );

        const output = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
          "status",
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.andThen(TestConsole.logLines),
          Effect.map((lines) => lines.join("\n")),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provide(
            Layer.mergeAll(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
              Layer.fresh(TestConsole.layer),
            ),
          ),
        );
        expect(output).not.toContain("repair");
      }),
  );
});

it.effect.each([
  ["a newer service", newerServiceStatus],
  ["another home's service", otherHomeStatus],
  ["a service for an unknown home", unknownHomeStatus],
] as const)("leaves %s unchanged during onboarding without prompting", ([, serviceStatus]) =>
  Effect.gen(function* () {
    const { service, installOptions } = makeTestService(serviceStatus);
    const terminal = Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readInput: Effect.die("Onboarding must not prompt to replace a newer service."),
      readLine: Effect.die("Onboarding must not prompt to replace a newer service."),
      display: () => Effect.die("Onboarding must not prompt to replace a newer service."),
    });

    const ready = yield* offerServiceDuringOnboarding.pipe(
      Effect.provideService(BootService.BootService, service),
      Effect.provideService(Terminal.Terminal, terminal),
      Effect.provide(NodeServices.layer),
    );

    expect(ready).toBe("skipped");
    expect(installOptions).toEqual([]);
  }),
);

// regression: #9602 diagnose incomplete headless server setup
it.effect("keeps the manual-server fallback when background prerequisites fail", () =>
  Effect.gen(function* () {
    const ready = yield* recoverServiceOnboardingOffer(
      Effect.fail(new BootService.BootServicePrerequisiteError({ problem: "linger-disabled" })),
    );
    expect(ready).toBe("skipped");
  }),
);
