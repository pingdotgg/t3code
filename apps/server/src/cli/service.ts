import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag, Prompt } from "effect/unstable/cli";
import { resolve } from "node:path";

import * as BootService from "../cloud/bootService.ts";
import { resolveBaseDir } from "../os-jank.ts";

const baseDir = Flag.string("base-dir").pipe(Flag.optional);
const cwd = Flag.string("cwd").pipe(Flag.optional);
const host = Flag.string("host").pipe(Flag.optional);
const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));
const decodePort = Schema.decodeUnknownEffect(PortSchema);
const port = Flag.integer("port").pipe(Flag.withSchema(PortSchema), Flag.optional);
const lifecycleFlags = { baseDir, cwd, host, port };

const withService = <A, E, R>(
  baseDirValue: string,
  effect: Effect.Effect<A, E, BootService.BootService | R>,
) =>
  effect.pipe(
    Effect.provide(
      Layer.effect(BootService.BootService, BootService.make({ baseDir: baseDirValue })),
    ),
  );

const resolveServiceBaseDir = (value: Option.Option<string>) =>
  resolveBaseDir(Option.getOrUndefined(value) ?? process.env.T3CODE_HOME);

const install = Command.make("install", lifecycleFlags).pipe(
  Command.withDescription("Install or repair the per-user background service and start it."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resolvedBaseDir = yield* resolveServiceBaseDir(flags.baseDir);
      return yield* withService(
        resolvedBaseDir,
        Effect.gen(function* () {
          const service = yield* BootService.BootService;
          const hostValue = Option.getOrUndefined(flags.host);
          const portValue = Option.getOrUndefined(flags.port);
          const plan = yield* service.install({
            cwd: resolve(Option.getOrElse(flags.cwd, () => process.cwd())),
            ...(hostValue === undefined ? {} : { host: hostValue }),
            ...(portValue === undefined ? {} : { port: portValue }),
          });
          yield* Console.log(
            `Background service installed and running.\nDefinition: ${plan.definitionPath}\nLogs: ${plan.logPath}`,
          );
        }),
      );
    }),
  ),
);

const action = (name: "start" | "restart" | "stop") =>
  Command.make(name, { baseDir }).pipe(
    Command.withDescription(`${name[0]!.toUpperCase()}${name.slice(1)} the background service.`),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        const resolvedBaseDir = yield* resolveServiceBaseDir(flags.baseDir);
        return yield* withService(
          resolvedBaseDir,
          Effect.gen(function* () {
            const service = yield* BootService.BootService;
            yield* service[name];
            yield* Console.log(`Background service ${name === "stop" ? "stopped" : `${name}ed`}.`);
          }),
        );
      }),
    ),
  );

const enable = Command.make("enable", { baseDir }).pipe(
  Command.withDescription("Enable startup persistence and start the background service."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resolvedBaseDir = yield* resolveServiceBaseDir(flags.baseDir);
      return yield* withService(
        resolvedBaseDir,
        Effect.gen(function* () {
          const service = yield* BootService.BootService;
          yield* service.enable;
          yield* Console.log("Background service enabled and running.");
        }),
      );
    }),
  ),
);

const disable = Command.make("disable", { baseDir }).pipe(
  Command.withDescription("Stop the service and disable automatic startup without removing it."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resolvedBaseDir = yield* resolveServiceBaseDir(flags.baseDir);
      return yield* withService(
        resolvedBaseDir,
        Effect.gen(function* () {
          const service = yield* BootService.BootService;
          yield* service.disable;
          yield* Console.log("Background service stopped and disabled.");
        }),
      );
    }),
  ),
);

export function formatServiceStatus(status: BootService.ServiceStatus): string {
  if (!status.supported) {
    return `T3 Code background service\n  Status: unsupported on ${status.platform}\n  Supported: macOS launchd`;
  }
  return [
    "T3 Code background service",
    `  Installed: ${status.installed ? "yes" : "no"}`,
    `  Enabled: ${status.enabled ? "yes" : "no"}`,
    `  Loaded: ${status.loaded ? "yes" : "no"}`,
    `  Process: ${status.processAlive ? `running${status.pid === undefined ? "" : ` (pid ${status.pid})`}` : "not running"}`,
    `  Responsive: ${status.responsive ? "yes" : "no"}`,
    `  Current: ${status.current ? "yes" : "no"}`,
    `  Definition: ${status.definitionPath}`,
    `  Logs: ${status.logPath}`,
  ].join("\n");
}

export const restartHealthyCurrentService = (
  service: {
    readonly restart: Effect.Effect<
      void,
      BootService.BootServiceError | BootService.BootServiceUnsupportedError
    >;
  },
  status: BootService.ServiceStatus,
) => {
  if (
    status.installed &&
    status.enabled &&
    status.current &&
    status.processAlive &&
    status.responsive
  ) {
    return service.restart.pipe(Effect.as(true));
  }
  return Effect.succeed(false);
};

const status = Command.make("status", { baseDir }).pipe(
  Command.withDescription("Show installed, enabled, process, health, and version state."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resolvedBaseDir = yield* resolveServiceBaseDir(flags.baseDir);
      return yield* withService(
        resolvedBaseDir,
        Effect.gen(function* () {
          const service = yield* BootService.BootService;
          yield* Console.log(formatServiceStatus(yield* service.status));
        }),
      );
    }),
  ),
);

const uninstall = Command.make("uninstall", { baseDir }).pipe(
  Command.withDescription("Stop, disable, and remove the background service."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const resolvedBaseDir = yield* resolveServiceBaseDir(flags.baseDir);
      return yield* withService(
        resolvedBaseDir,
        Effect.gen(function* () {
          const service = yield* BootService.BootService;
          yield* Console.log(
            (yield* service.uninstall)
              ? "Background service removed."
              : "Background service is not installed.",
          );
        }),
      );
    }),
  ),
);

export const offerServiceDuringOnboarding = (input?: {
  readonly baseDir?: string;
  readonly cwd?: string;
}) =>
  Effect.gen(function* () {
    const service = yield* BootService.BootService;
    const status = yield* service.status;
    if (!status.supported) return false;
    if (yield* restartHealthyCurrentService(service, status)) return true;
    const accepted = yield* Prompt.run(
      Prompt.confirm({
        message: "Keep T3 reachable in the background after this terminal closes?",
        initial: true,
      }),
    );
    if (!accepted) return false;
    const hostValue = process.env.T3CODE_HOST;
    const portValue = process.env.T3CODE_PORT;
    const parsedPort = portValue === undefined ? undefined : yield* decodePort(Number(portValue));
    yield* service.install({
      cwd: resolve(input?.cwd ?? process.cwd()),
      ...(hostValue === undefined ? {} : { host: hostValue }),
      ...(parsedPort === undefined ? {} : { port: parsedPort }),
    });
    return true;
  });

export const recoverServiceOnboardingOffer = <R>(offer: Effect.Effect<boolean, unknown, R>) =>
  offer.pipe(
    Effect.catch((error: unknown) =>
      typeof error === "object" && error !== null && "_tag" in error && error._tag === "QuitError"
        ? Effect.succeed(false)
        : Console.warn(
            `T3 Connect succeeded, but background setup did not finish: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ).pipe(Effect.as(false)),
    ),
  );

export const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Manage the durable T3 Code background service."),
  Command.withSubcommands([
    install,
    enable,
    action("start"),
    action("restart"),
    action("stop"),
    disable,
    status,
    uninstall,
  ]),
);
