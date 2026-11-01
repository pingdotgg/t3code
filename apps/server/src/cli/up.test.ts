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
import * as Tailscale from "@t3tools/tailscale";
import { afterEach, vi } from "vite-plus/test";

// The tests must not depend on Tailscale running on the machine that runs them.
vi.mock("@t3tools/tailscale", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/tailscale")>()),
  readTailscaleStatus: () => Effect.fail("Tailscale is not running in tests"),
}));

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { upsertServiceEnv } from "./service.ts";
import { connectEnabled, planRoutes, resolveOwner, upCommand, upPortCheck } from "./up.ts";

const TAGGED_HOST: Tailscale.TailscaleStatus = {
  version: "1.90.0",
  magicDnsName: "box.example.ts.net",
  tailnetIpv4Addresses: ["100.64.0.2"],
  httpsServeEnabled: null,
  backendState: "Running",
  selfNodeId: "n1",
  selfUserId: null,
  selfTags: ["tag:t3-box"],
  keyExpiry: null,
  keyExpired: false,
  health: [],
  magicDnsEnabled: true,
  certDomains: [],
  userspaceNetworking: false,
  peers: [],
  unidentifiedPeerAddresses: [],
  users: [{ userId: "123", loginName: "me@example.com" }],
};

const none = Option.none<boolean>();
const off = { tailscale: false, connect: false, lan: false };
const both = { tailscale: true, connect: true };
const noFlags = { tailscale: none, connect: none, lan: none };

it.each([
  {
    label: "a new machine with Tailscale starts from it and asks",
    setup: { installed: false, current: off, available: both },
    flags: noFlags,
    expected: { routes: { ...off, tailscale: true }, ask: ["tailscale", "connect", "lan"] },
  },
  {
    label: "a new machine without Tailscale starts from T3 Connect",
    setup: { installed: false, current: off, available: { tailscale: false, connect: true } },
    flags: noFlags,
    expected: { routes: { ...off, connect: true }, ask: ["connect", "lan"] },
  },
  {
    label: "a rerun starts from the current setup and can turn a route off",
    setup: {
      installed: true,
      current: { ...off, tailscale: true, lan: true },
      available: { tailscale: false, connect: false },
    },
    flags: noFlags,
    expected: { routes: { ...off, tailscale: true, lan: true }, ask: ["tailscale", "lan"] },
  },
  {
    label: "another setup flag asks nothing and keeps every route, even on a new machine",
    setup: { installed: false, current: off, available: both },
    flags: { ...noFlags, other: true },
    expected: { routes: off, ask: [] },
  },
  {
    label: "a route flag asks nothing and keeps the routes not named, even on a new machine",
    setup: { installed: false, current: off, available: both },
    flags: { ...noFlags, lan: Option.some(true) },
    expected: { routes: { ...off, lan: true }, ask: [] },
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

it.each([
  {
    label: "a CLI managed link",
    cliDesired: true,
    cliMode: "managed",
    managedTunnel: false,
    revoked: false,
    on: true,
  },
  {
    label: "a link the app made",
    cliDesired: false,
    cliMode: "managed",
    managedTunnel: true,
    revoked: false,
    on: true,
  },
  {
    label: "a publish-only link",
    cliDesired: true,
    cliMode: "publish_only",
    managedTunnel: false,
    revoked: false,
    on: false,
  },
  {
    label: "a publish-only link with an old tunnel config",
    cliDesired: true,
    cliMode: "publish_only",
    managedTunnel: true,
    revoked: false,
    on: false,
  },
  {
    label: "a revoked link",
    cliDesired: true,
    cliMode: "managed",
    managedTunnel: true,
    revoked: true,
    on: false,
  },
  {
    label: "no link",
    cliDesired: false,
    cliMode: "managed",
    managedTunnel: false,
    revoked: false,
    on: false,
  },
] as const)("T3 Connect is on for $label: $on", ({ label: _, on, ...link }) => {
  expect(connectEnabled(link)).toBe(on);
});

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

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("t3 up", (it) => {
  afterEach(() => vi.restoreAllMocks());

  it.effect.each<{
    readonly label: string;
    readonly installed: boolean;
    readonly status?: Partial<BootService.BootServiceStatus>;
    readonly installFails?: boolean;
    readonly restartFails?: boolean;
    /** What Tailscale reports here. Without it, Tailscale does not answer. */
    readonly tailscale?: Tailscale.TailscaleStatus;
    /** `t3 up` exits with an error. */
    readonly fails?: boolean;
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
      prints: "The service kept its old settings. Fix that, then run `t3 up` again.",
      fails: true,
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
      label: "no service manager still records the choice",
      // Every choice is explicit, so the shell's environment cannot change it.
      prints: "--lan --no-tailscale-sign-in --no-tailscale-serve",
      installed: false,
      status: { supported: false },
      env: "",
      args: ["--lan"],
      installs: 0,
      restarts: 0,
      envAfter: "T3CODE_LAN=true\n",
    },
    {
      label: "Tailscale down here keeps its settings while another route changes",
      installed: true,
      env: "T3CODE_LAN=true\nT3CODE_TAILSCALE_SIGN_IN=true\n",
      args: ["--no-lan"],
      installs: 0,
      restarts: 1,
      envAfter: "T3CODE_LAN=false\nT3CODE_TAILSCALE_SIGN_IN=true\n",
    },
    {
      label: "turning Tailscale off stops Serve too, written as false",
      installed: true,
      env: "T3CODE_LAN=false\nT3CODE_TAILSCALE_SIGN_IN=true\nT3CODE_TAILSCALE_SERVE=true\n",
      args: ["--no-tailscale"],
      installs: 0,
      restarts: 1,
      envAfter: "T3CODE_LAN=false\nT3CODE_TAILSCALE_SIGN_IN=false\nT3CODE_TAILSCALE_SERVE=false\n",
    },
    {
      // Only turning Serve on implies Tailscale. Off is written, since it may be inherited.
      label: "--no-tailscale-serve leaves Tailscale off and pins Serve off",
      installed: true,
      env: "T3CODE_LAN=false\n",
      args: ["--no-tailscale-serve"],
      installs: 0,
      restarts: 1,
      envAfter: "T3CODE_LAN=false\nT3CODE_TAILSCALE_SERVE=false\n",
    },
    {
      label: "--no-tailscale pins sign-in off even when the file says nothing",
      installed: true,
      env: "T3CODE_LAN=false\n",
      args: ["--no-tailscale"],
      installs: 0,
      restarts: 1,
      envAfter: "T3CODE_LAN=false\nT3CODE_TAILSCALE_SIGN_IN=false\nT3CODE_TAILSCALE_SERVE=false\n",
    },
    {
      label: "--no-tailscale-serve turns Serve off while Tailscale is down here",
      installed: true,
      env: "T3CODE_LAN=false\nT3CODE_TAILSCALE_SIGN_IN=true\nT3CODE_TAILSCALE_SERVE=true\n",
      args: ["--no-tailscale-serve"],
      installs: 0,
      restarts: 1,
      envAfter: "T3CODE_LAN=false\nT3CODE_TAILSCALE_SIGN_IN=true\nT3CODE_TAILSCALE_SERVE=false\n",
    },
    {
      label: "--no-tailscale pins Serve off when sign-in was already off",
      installed: true,
      env: "T3CODE_LAN=false\nT3CODE_TAILSCALE_SIGN_IN=false\n",
      args: ["--no-tailscale"],
      installs: 0,
      restarts: 1,
      envAfter: "T3CODE_LAN=false\nT3CODE_TAILSCALE_SIGN_IN=false\nT3CODE_TAILSCALE_SERVE=false\n",
    },
    {
      label: "--no-tailscale writes its offs with no service to run",
      installed: false,
      env: "",
      args: ["--no-tailscale"],
      installs: 0,
      restarts: 0,
      envAfter: "T3CODE_TAILSCALE_SIGN_IN=false\nT3CODE_TAILSCALE_SERVE=false\n",
    },
    {
      label: "--no-tailscale-serve writes Serve off with no service to run",
      installed: false,
      env: "T3CODE_TAILSCALE_SIGN_IN=false\nT3CODE_TAILSCALE_SERVE=true\n",
      args: ["--no-tailscale-serve"],
      installs: 0,
      restarts: 0,
      envAfter: "T3CODE_TAILSCALE_SIGN_IN=false\nT3CODE_TAILSCALE_SERVE=false\n",
    },
    {
      // With no saved owner and no terminal, choosing Tailscale would fail with "Pass --owner".
      label: "--no-tailscale-serve on a tagged host asks for no owner",
      installed: true,
      tailscale: TAGGED_HOST,
      env: "T3CODE_LAN=false\nT3CODE_TAILSCALE_SIGN_IN=true\nT3CODE_TAILSCALE_SERVE=true\n",
      args: ["--no-tailscale-serve"],
      installs: 0,
      restarts: 1,
      envAfter: "T3CODE_LAN=false\nT3CODE_TAILSCALE_SIGN_IN=true\nT3CODE_TAILSCALE_SERVE=false\n",
    },
    {
      // Not written as a choice, so status keeps calling it the older install's.
      label: "the old default is kept, still marked as the old default",
      installed: true,
      env: "",
      args: ["--yes"],
      installs: 0,
      restarts: 0,
      envAfter: "",
    },
  ])("restarts the service only when it must: $label", (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-up-test-" });
      yield* fs.writeFileString(`${baseDir}/service.env`, input.env);
      if (input.tailscale !== undefined) {
        vi.spyOn(Tailscale, "readTailscaleStatus").mockReturnValue(Effect.succeed(input.tailscale));
      }
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

      if (input.answer !== undefined) yield* asTerminal;
      const { exit, lines } = yield* Command.runWith(upCommand, { version: packageJson.version })([
        "--base-dir",
        baseDir,
        ...input.args,
      ]).pipe(
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
        const failure = exit._tag === "Failure" ? Cause.pretty(exit.cause) : "";
        expect(`${lines.join("\n")}\n${failure}`).toContain(input.prints);
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

const RUNNING_SERVICE = { port: 3773, serviceManaged: true };
const MANUAL = { port: 3773, serviceManaged: false };

it.each([
  { configuredPort: undefined, free: true, running: null, expected: "ok" },
  { configuredPort: undefined, free: false, running: RUNNING_SERVICE, expected: "ok" },
  { configuredPort: undefined, free: false, running: null, expected: "taken" },
  { configuredPort: undefined, free: false, running: MANUAL, expected: "manual" },
  // t3 up writes T3CODE_PORT=3773, so a later run still checks the port.
  { configuredPort: "3773", free: false, running: null, expected: "taken" },
  { configuredPort: "3773", free: false, running: RUNNING_SERVICE, expected: "ok" },
  { configuredPort: "4000", free: true, running: null, expected: "custom" },
  { configuredPort: "4000", free: true, running: { ...MANUAL, port: 4000 }, expected: "manual" },
] as const)(
  "port check with T3CODE_PORT=$configuredPort, free=$free, running=$running is $expected",
  ({ configuredPort, free, running, expected }) => {
    expect(upPortCheck({ configuredPort, portFree: free, running })).toBe(expected);
  },
);

it.effect("a rerun on a tagged host keeps the owner saved before, with no prompt", () =>
  Effect.gen(function* () {
    // Not interactive, as with --yes, so asking would fail with "Pass --owner".
    expect(yield* resolveOwner(TAGGED_HOST, Option.none(), "123", false)).toEqual({
      userId: "123",
      login: "me@example.com",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
