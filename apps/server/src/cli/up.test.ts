import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { upsertServiceEnv } from "./service.ts";
import { planRoutes, upCommand } from "./up.ts";

const none = Option.none<boolean>();

it.each([
  {
    label: "a new machine starts from T3 Connect and asks",
    setup: { installed: false, connect: false, lan: false },
    flags: { connect: none, lan: none },
    expected: { routes: { connect: true, lan: false }, ask: ["connect", "lan"] },
  },
  {
    label: "a build without T3 Connect never offers it",
    setup: { installed: false, connect: null, lan: false },
    flags: { connect: none, lan: none },
    expected: { routes: { connect: false, lan: false }, ask: ["lan"] },
  },
  {
    label: "a rerun starts from the current setup",
    setup: { installed: true, connect: false, lan: true },
    flags: { connect: none, lan: none },
    expected: { routes: { connect: false, lan: true }, ask: ["connect", "lan"] },
  },
  {
    label: "a route flag on a new machine turns on only that route",
    setup: { installed: false, connect: false, lan: false },
    flags: { connect: none, lan: Option.some(true) },
    expected: { routes: { connect: false, lan: true }, ask: [] },
  },
  {
    label: "a route flag asks nothing and keeps the other route",
    setup: { installed: true, connect: true, lan: true },
    flags: { connect: none, lan: Option.some(false) },
    expected: { routes: { connect: true, lan: false }, ask: [] },
  },
])("$label", ({ setup, flags, expected }) => {
  expect(planRoutes(setup, flags)).toEqual(expected);
});

const SERVICE = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/t3code.service",
  logPath: "/home/me/.t3/userdata/logs/boot-service.log",
} as const;

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("t3 up", (it) => {
  afterEach(() => vi.restoreAllMocks());

  it.effect.each<{
    readonly label: string;
    readonly installed: boolean;
    readonly status?: Partial<BootService.BootServiceStatus>;
    readonly installFails?: boolean;
    readonly restartFails?: boolean;
    readonly env: string;
    readonly args: ReadonlyArray<string>;
    readonly installs: number;
    readonly restarts: number;
    readonly envAfter: string;
  }>([
    {
      label: "nothing changed",
      installed: true,
      env: "T3CODE_LAN=false\n",
      args: ["--no-lan"],
      installs: 0,
      restarts: 0,
      envAfter: "T3CODE_LAN=false\n",
    },
    {
      label: "the local network opens",
      installed: true,
      env: "T3CODE_LAN=false\n",
      args: ["--lan"],
      installs: 0,
      restarts: 1,
      envAfter: "T3CODE_LAN=true\n",
    },
    {
      label: "a new service starts with its settings",
      installed: false,
      env: "",
      args: ["--lan"],
      installs: 1,
      restarts: 0,
      envAfter: "T3CODE_LAN=true\n",
    },
    {
      label: "a route turns off with no service to run",
      installed: false,
      env: "T3CODE_LAN=true\n",
      args: ["--no-lan"],
      installs: 0,
      restarts: 0,
      envAfter: "T3CODE_LAN=false\n",
    },
    {
      label: "a stopped newer service starts as it is",
      installed: true,
      status: { current: false, installedVersion: "999.0.0", problems: ["service-stopped"] },
      env: "T3CODE_LAN=false\n",
      args: ["--yes"],
      installs: 0,
      restarts: 1,
      envAfter: "T3CODE_LAN=false\n",
    },
    {
      label: "a failed update keeps service.env matching the old service",
      installed: true,
      status: { current: false },
      installFails: true,
      env: "",
      args: ["--no-lan"],
      installs: 0,
      restarts: 0,
      envAfter: "",
    },
    {
      label: "a failed restart keeps service.env matching the running service",
      installed: true,
      restartFails: true,
      env: "T3CODE_LAN=false\n",
      args: ["--lan"],
      installs: 0,
      restarts: 1,
      envAfter: "T3CODE_LAN=false\n",
    },
    {
      label: "the old default is kept",
      installed: true,
      env: "",
      args: ["--yes"],
      installs: 0,
      restarts: 0,
      envAfter: "T3CODE_LAN=true\n",
    },
  ])("restarts the service only when it must: $label", (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-up-test-" });
      yield* fs.writeFileString(`${baseDir}/service.env`, input.env);
      let installs = 0;
      let restarts = 0;
      const status = {
        ...SERVICE,
        installed: input.installed,
        current: input.installed,
        ...input.status,
      };
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(
          BootService.BootService,
          BootService.BootService.of({
            status: Effect.succeed(status),
            withStopped: (operation) => operation,
            restart: Effect.sync(() => restarts++).pipe(
              Effect.andThen(
                input.restartFails === true
                  ? Effect.fail(new BootService.BootServiceCommandError({ step: "restart" }))
                  : Effect.succeed("restarted" as const),
              ),
            ),
            install: () =>
              input.installFails === true
                ? Effect.fail(
                    new BootService.BootServicePrerequisiteError({ problem: "linger-disabled" }),
                  )
                : Effect.sync(() => {
                    installs++;
                    return {
                      program: ["t3"],
                      baseDir,
                      unitPath: status.unitPath,
                      logPath: status.logPath,
                    };
                  }),
            uninstall: Effect.succeed(false),
          }),
        ),
      );

      const exit = yield* Command.runWith(upCommand, { version: packageJson.version })([
        "--base-dir",
        baseDir,
        ...input.args,
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
      expect(exit._tag).toBe(input.restartFails === true ? "Failure" : "Success");
      expect({ installs, restarts }).toEqual({
        installs: input.installs,
        restarts: input.restarts,
      });
      expect(yield* fs.readFileString(`${baseDir}/service.env`)).toBe(input.envAfter);
    }),
  );
});

it("rewrites only the named service.env keys and keeps the user's lines", () => {
  const before = ["# my settings", "T3CODE_PORT=4000", "export T3CODE_LAN=0", "T3CODE_LAN=1", ""];
  expect(upsertServiceEnv(before.join("\n"), { T3CODE_LAN: "true", T3CODE_HOST: undefined })).toBe(
    ["# my settings", "T3CODE_PORT=4000", "T3CODE_LAN=true", ""].join("\n"),
  );
  expect(upsertServiceEnv("", { T3CODE_LAN: "false" })).toBe("T3CODE_LAN=false\n");
});
