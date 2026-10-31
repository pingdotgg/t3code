import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { upCommand } from "./up.ts";

// T3 Connect's flows run only in builds with its public config, and they call
// the relay; this file swaps in the link and unlink steps.
const events = vi.hoisted((): Array<string> => []);
// The CLI link marker, kept in memory instead of the secret store.
const link = vi.hoisted(() => ({
  desired: false,
  mode: "managed" as "managed" | "publish_only",
}));
vi.mock("../cloud/CliState.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloud/CliState.ts")>()),
  readCliDesiredCloudLink: Effect.sync(() => link.desired),
  readCliDesiredLinkMode: Effect.sync(() => link.mode),
  setCliDesiredCloudLink: (desired: boolean, mode: "managed" | "publish_only" = "managed") =>
    Effect.sync(() => {
      link.desired = desired;
      link.mode = mode;
    }),
}));
vi.mock("../cloud/publicConfig.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloud/publicConfig.ts")>()),
  hasCloudPublicConfig: true,
}));
vi.mock("./connect.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./connect.ts")>();
  return {
    ...actual,
    linkEnvironmentForConnect: () =>
      Effect.sync(() => {
        events.push("link");
        link.desired = true;
        link.mode = "managed";
        return { identity: "me@example.com" } as const;
      }),
    disconnectCloud: () =>
      Effect.sync(() => {
        events.push("unlink");
        link.desired = false;
        return { status: "succeeded" } as const;
      }),
  };
});

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("t3 up with T3 Connect", (it) => {
  it.effect.each([
    { label: "no link", prior: null, events: ["link", "restart", "unlink", "restart"] },
    // The publish-only link comes back, with its activity publishing.
    {
      label: "a publish-only link",
      prior: "publish_only" as const,
      events: ["link", "restart", "restart"],
    },
  ])("a failed restart after --connect undoes it, then restarts: $label before", (input) =>
    Effect.gen(function* () {
      events.length = 0;
      link.desired = input.prior !== null;
      link.mode = input.prior ?? "managed";
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-up-connect-test-" });
      yield* fs.writeFileString(`${baseDir}/service.env`, "T3CODE_LAN=false\n");
      const status = {
        supported: true,
        installed: true,
        current: true,
        unitPath: "/home/me/.config/systemd/user/t3code.service",
        logPath: "/home/me/.t3/userdata/logs/boot-service.log",
      };
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(
          BootService.BootService,
          BootService.BootService.of({
            status: Effect.succeed(status),
            withStopped: (operation) => operation,
            restart: Effect.sync(() => events.push("restart")).pipe(
              Effect.andThen(
                Effect.fail(new BootService.BootServiceCommandError({ step: "restart" })),
              ),
            ),
            install: () => Effect.die("an installed, current service is not reinstalled"),
            uninstall: Effect.succeed(false),
          }),
        ),
      );

      const exit = yield* Command.runWith(upCommand, { version: packageJson.version })([
        "--base-dir",
        baseDir,
        "--connect",
      ]).pipe(
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
        Effect.exit,
      );

      expect(exit._tag).toBe("Failure");
      // Any unlink comes before the restart on the old settings.
      expect(events).toEqual(input.events);
      expect(link).toEqual(
        input.prior === null
          ? { desired: false, mode: "managed" }
          : { desired: true, mode: input.prior },
      );
      expect(yield* fs.readFileString(`${baseDir}/service.env`)).toBe("T3CODE_LAN=false\n");
    }),
  );
});
