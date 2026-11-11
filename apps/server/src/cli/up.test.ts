import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Terminal from "effect/Terminal";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../service/bootService.ts";
import { upsertServiceEnv } from "./service.ts";
import { statusCommand, upCommand } from "./up.ts";

const SERVICE = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/t3code.service",
  logPath: "/home/me/.t3/userdata/logs/boot-service.log",
} as const;

// Prompts run only when both streams are terminals.
const asTerminal = Effect.acquireRelease(
  Effect.sync(() =>
    [process.stdin, process.stdout].map((stream) => {
      const descriptor = Object.getOwnPropertyDescriptor(stream, "isTTY");
      Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
      return { stream, descriptor };
    }),
  ),
  (saved) =>
    Effect.sync(() => {
      for (const { stream, descriptor } of saved) {
        if (descriptor === undefined) Reflect.deleteProperty(stream, "isTTY");
        else Object.defineProperty(stream, "isTTY", descriptor);
      }
    }),
);

const answering = (text: string) =>
  Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    size: Queue.unbounded<Terminal.Size, Cause.Done>(),
    readInput: Effect.gen(function* () {
      const input = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>();
      yield* Queue.offer(input, {
        input: Option.some(text),
        key: { name: text, ctrl: false, meta: false, shift: false },
      });
      return input;
    }),
    readLine: Effect.succeed(text),
    display: () => Effect.void,
  });

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))("t3 up", (it) => {
  afterEach(() => vi.restoreAllMocks());

  it.effect.each<{
    readonly label: string;
    readonly installed: boolean;
    readonly status?: Partial<BootService.BootServiceStatus>;
    readonly installFails?: boolean;
    readonly restartFails?: boolean;
    readonly fails?: boolean;
    readonly reportStatus?: boolean;
    /** Runs as if in a terminal, answering each question with this text. */
    readonly answer?: string;
    readonly prints?: string;
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
      prints: "Run `t3 pair --base-dir <baseDir>`.",
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
      // The old service still runs, so no foreground server is offered.
      prints: "Fix that, then run `t3 up --base-dir <baseDir>` again.",
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
      label: "a failed restart puts service.env back and restarts on it",
      installed: true,
      restartFails: true,
      env: "T3CODE_LAN=false\n",
      args: ["--lan"],
      installs: 0,
      restarts: 2,
      envAfter: "T3CODE_LAN=false\n",
    },
    {
      label: "declining an update changes nothing",
      installed: true,
      status: { current: false },
      answer: "n",
      env: "T3CODE_LAN=false\n",
      args: ["--lan"],
      installs: 0,
      restarts: 0,
      envAfter: "T3CODE_LAN=false\n",
    },
    {
      label: "a service for another home is refused without a restart",
      installed: true,
      status: { current: false, otherBaseDir: "/srv/t3 home" },
      fails: true,
      answer: "y",
      env: "T3CODE_LAN=false\n",
      args: ["--lan"],
      installs: 0,
      restarts: 0,
      envAfter: "T3CODE_LAN=false\n",
    },
    {
      label: "another home's service supplies no local network default",
      installed: true,
      status: { current: false, otherBaseDir: "/srv/t3 home" },
      reportStatus: true,
      env: "",
      args: ["--json"],
      installs: 0,
      restarts: 0,
      envAfter: "",
    },
    {
      label: "no service manager still records the choice",
      installed: false,
      status: { supported: false },
      env: "",
      args: ["--lan"],
      installs: 0,
      restarts: 0,
      envAfter: "T3CODE_LAN=true\n",
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
  ])("keeps service changes and access settings consistent: $label", (input) =>
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
              status.otherBaseDir !== undefined
                ? Effect.fail(
                    new BootService.BootServiceOtherBaseDirError({
                      installedBaseDir: status.otherBaseDir,
                      baseDir,
                    }),
                  )
                : input.installFails === true
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

      if (input.answer !== undefined) yield* asTerminal;
      const run = input.reportStatus
        ? Command.runWith(statusCommand, { version: packageJson.version })
        : Command.runWith(upCommand, { version: packageJson.version });
      const { exit, lines } = yield* run(["--base-dir", baseDir, ...input.args]).pipe(
        Effect.provideService(HostProcess.Environment, {}),
        input.answer === undefined
          ? (effect) => effect
          : Effect.provideService(Terminal.Terminal, answering(input.answer)),
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.map(TestConsole.logLines, (lines) => ({ exit, lines: lines.map(String) })),
        ),
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );
      if (input.prints !== undefined) {
        expect(lines.join("\n")).toContain(input.prints.replace("<baseDir>", baseDir));
      }
      if (input.reportStatus) {
        expect(JSON.parse(lines.join("\n"))).toMatchObject({
          service: { otherBaseDir: "/srv/t3 home" },
          lan: { enabled: false, inheritedDefault: false },
        });
      }
      expect(exit._tag).toBe(
        input.restartFails === true || input.fails === true ? "Failure" : "Success",
      );
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
