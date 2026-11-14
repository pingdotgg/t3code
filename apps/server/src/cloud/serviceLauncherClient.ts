import type { ServerSelfUpdateOutcome } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import { pinnedRuntimePaths, pinnedRuntimeVersionsDir } from "./pinnedRuntime.ts";
import {
  decodeServiceLauncherContext,
  decodeServiceLauncherParentMessage,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  type ServiceLauncherChildMessage,
  type ServiceLauncherParentMessage,
  type SupportedLauncherProtocol,
} from "./serviceProtocol.ts";

export class ServiceLauncherClientError extends Schema.TaggedError<ServiceLauncherClientError>()(
  "ServiceLauncherClientError",
  {
    operation: Schema.Literals([
      "decode-context",
      "version-mismatch",
      "unmanaged",
      "send",
      "disconnect",
      "timeout",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "decode-context":
        return "The service launcher supplied invalid startup context.";
      case "version-mismatch":
        return "The service launcher started a different t3 version.";
      case "unmanaged":
        return "This server is not managed by the launcher.";
      case "send":
        return "Could not send a request to the service launcher.";
      case "disconnect":
        return "The service launcher disconnected before acknowledging the request.";
      case "timeout":
        return "The service launcher did not respond within 30 seconds.";
    }
  }
}

export class ServiceLauncherRejectedError extends Schema.TaggedError<ServiceLauncherRejectedError>()(
  "ServiceLauncherRejectedError",
  {
    targetVersion: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

interface ServiceLauncherProcess {
  readonly connected: boolean;
  readonly send: (
    message: ServiceLauncherChildMessage,
    callback?: (error: Error | null) => void,
  ) => boolean;
  readonly on: (
    event: "message" | "disconnect",
    listener: (...args: ReadonlyArray<unknown>) => void,
  ) => void;
  readonly off: (
    event: "message" | "disconnect",
    listener: (...args: ReadonlyArray<unknown>) => void,
  ) => void;
}

export const ServiceLauncherHostProcess = Context.Reference<ServiceLauncherProcess>(
  "t3/cloud/serviceLauncherHostProcess",
  {
    defaultValue: () => ({
      connected: process.connected && process.send !== undefined,
      send: (message, callback) => {
        if (process.send === undefined) return false;
        return callback === undefined ? process.send(message) : process.send(message, callback);
      },
      on: (event, listener) => {
        process.on(event, listener);
      },
      off: (event, listener) => {
        process.off(event, listener);
      },
    }),
  },
);

export class ServiceLauncherClient extends Context.Service<
  ServiceLauncherClient,
  {
    readonly managed: boolean;
    /** The supervising launcher's protocol. A remote update never replaces the launcher,
        so it can be older than this runtime's own. */
    readonly protocol: SupportedLauncherProtocol | undefined;
    readonly requestUpdate: (input: {
      readonly targetVersion: string;
      readonly dbPath: string;
    }) => Effect.Effect<string, ServiceLauncherClientError | ServiceLauncherRejectedError>;
    /** Owned `t3` symlinks move to the new runtime only when this start commits the trial. */
    readonly prepareTrial: (input: {
      readonly baseDir: string;
    }) => Effect.Effect<ServerSelfUpdateOutcome | undefined, ServiceLauncherClientError>;
  }
>()("t3/cloud/serviceLauncherClient") {}

const resolveStartup = Effect.fn("cloud.service_launcher_client.resolve_startup")(
  function* (options?: { readonly currentVersion?: string }) {
    const host = yield* ServiceLauncherHostProcess;
    const environment = yield* HostProcess.Environment;
    const currentVersion = options?.currentVersion ?? packageJson.version;
    // IPC channels are not inherited; without one, launcher context belongs to an ancestor.
    const rawContext = host.connected ? environment[SERVICE_LAUNCHER_CONTEXT_ENV] : undefined;
    const context = rawContext === undefined ? undefined : decodeServiceLauncherContext(rawContext);

    if (rawContext !== undefined && context === undefined) {
      return yield* new ServiceLauncherClientError({ operation: "decode-context" });
    }
    if (context !== undefined && context.childVersion !== currentVersion) {
      return yield* new ServiceLauncherClientError({ operation: "version-mismatch" });
    }

    const managed = context !== undefined;

    return { host, context, managed };
  },
);

export const resolveServiceLauncherMode = Effect.fn("cloud.service_launcher_client.resolve_mode")(
  function* () {
    const { managed } = yield* resolveStartup();
    return { managed };
  },
);

export const repointLaunchers = Effect.fn("cloud.service_launcher_client.repoint_launchers")(
  function* (input: { readonly baseDir: string; readonly targetVersion: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    if (platform !== "linux" && platform !== "darwin") return;
    const installBinDir =
      environment["T3CODE_INSTALL_BIN_DIR"] ||
      (environment["HOME"] ? path.join(environment["HOME"], ".local", "bin") : undefined);
    const candidates = new Set<string>();
    if (installBinDir !== undefined) candidates.add(path.join(installBinDir, "t3"));
    for (const directory of (environment["PATH"] ?? "").split(":")) {
      if (directory.length === 0) continue;
      const candidate = path.join(directory, "t3");
      if (
        yield* fs.exists(candidate).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not check the t3 command on PATH", {
              launchedAs: candidate,
              cause,
            }).pipe(Effect.as(false)),
          ),
        )
      ) {
        candidates.add(candidate);
        break;
      }
    }
    const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
    const target = pinnedRuntimePaths(path, input.baseDir, input.targetVersion, platform);
    for (const launchedAs of candidates) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const linkTarget = yield* fs.readLink(launchedAs).pipe(
            Effect.asSome,
            Effect.catchIf(
              (error) =>
                error.reason._tag === "NotFound" ||
                (error.reason.cause as NodeJS.ErrnoException | undefined)?.code === "EINVAL",
              () => Effect.succeedNone,
            ),
          );
          if (Option.isNone(linkTarget)) return;
          const relative = path.relative(
            versionsDir,
            path.resolve(path.dirname(launchedAs), linkTarget.value),
          );
          if (
            relative.length === 0 ||
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          )
            return;
          const temporary = yield* fs.makeTempDirectoryScoped({
            directory: path.dirname(launchedAs),
            prefix: ".t3-launcher-",
          });
          const link = path.join(temporary, "t3");
          yield* fs.symlink(target.entryPath, link);
          yield* fs.rename(link, launchedAs);
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Could not move the t3 command to the updated version", {
                launchedAs,
                cause,
              }),
        ),
      );
    }
  },
);

/** Completes when the launcher asks this server to stop, which Windows cannot signal. */
export const awaitServiceLauncherStop = Effect.fn("cloud.service_launcher_client.await_stop")(
  function* (options?: { readonly currentVersion?: string }) {
    const startup = yield* resolveStartup(options).pipe(Effect.option);
    if (Option.isNone(startup) || !startup.value.managed) return yield* Effect.never;
    const { host } = startup.value;
    return yield* Effect.callback<void>((resume) => {
      const onMessage = (...args: ReadonlyArray<unknown>) => {
        if (decodeServiceLauncherParentMessage(args[0])?.type === "stop") resume(Effect.void);
      };
      host.on("message", onMessage);
      return Effect.sync(() => host.off("message", onMessage));
    });
  },
);

export const make = Effect.fn("cloud.service_launcher_client.make")(function* (options?: {
  readonly currentVersion?: string;
}) {
  const { host, context, managed } = yield* resolveStartup(options);
  // prepareTrial runs later, outside whatever context built the client.
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;

  const exchange = (
    message: ServiceLauncherChildMessage,
    accept: (reply: ServiceLauncherParentMessage) => boolean,
  ) =>
    Effect.callback<ServiceLauncherParentMessage, ServiceLauncherClientError>((resume) => {
      if (!managed) {
        resume(Effect.fail(new ServiceLauncherClientError({ operation: "unmanaged" })));
        return;
      }

      let settled = false;
      const cleanup = () => {
        host.off("message", onMessage);
        host.off("disconnect", onDisconnect);
      };
      const settle = (
        effect: Effect.Effect<ServiceLauncherParentMessage, ServiceLauncherClientError>,
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(effect);
      };
      const onMessage = (...args: ReadonlyArray<unknown>) => {
        const reply = decodeServiceLauncherParentMessage(args[0]);
        if (reply !== undefined && accept(reply)) settle(Effect.succeed(reply));
      };
      const onDisconnect = () =>
        settle(Effect.fail(new ServiceLauncherClientError({ operation: "disconnect" })));

      host.on("message", onMessage);
      host.on("disconnect", onDisconnect);
      try {
        host.send(message, (error) => {
          if (error !== null) {
            settle(
              Effect.fail(new ServiceLauncherClientError({ operation: "send", cause: error })),
            );
          }
        });
      } catch (cause) {
        settle(Effect.fail(new ServiceLauncherClientError({ operation: "send", cause })));
      }

      return Effect.sync(cleanup);
    }).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.fail(new ServiceLauncherClientError({ operation: "timeout" })),
      }),
    );

  const requestUpdate = (input: { readonly targetVersion: string; readonly dbPath: string }) =>
    exchange(
      { type: "request-update", ...input },
      (reply) => reply.type === "update-accepted" || reply.type === "update-rejected",
    ).pipe(
      Effect.flatMap((reply) =>
        reply.type === "update-accepted"
          ? Effect.succeed(reply.updateId)
          : reply.type === "update-rejected"
            ? Effect.fail(
                new ServiceLauncherRejectedError({
                  targetVersion: input.targetVersion,
                  reason: reply.reason,
                }),
              )
            : Effect.die("service launcher returned an impossible update response"),
      ),
    );

  const pending = context?.update?.status === "pending" ? context.update : undefined;
  const outcome =
    context?.update === undefined || context.update.status === "pending"
      ? undefined
      : context.update;
  const prepareTrial = (input: { readonly baseDir: string }) =>
    pending !== undefined
      ? exchange(
          { type: "prepared", updateId: pending.id },
          (reply) => reply.type === "committed" && reply.updateId === pending.id,
        ).pipe(
          Effect.flatMap((reply) =>
            reply.type !== "committed"
              ? Effect.die("service launcher returned an impossible prepared response")
              : repointLaunchers({
                  baseDir: input.baseDir,
                  targetVersion: pending.targetVersion,
                }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                  Effect.provideService(HostProcess.Environment, environment),
                  Effect.provideService(HostProcess.Platform, platform),
                  Effect.as({
                    id: pending.id,
                    fromVersion: pending.fromVersion,
                    targetVersion: pending.targetVersion,
                    status: "committed" as const,
                  }),
                ),
          ),
        )
      : Effect.succeed(outcome);

  return ServiceLauncherClient.of({
    managed,
    protocol: context?.protocol,
    requestUpdate,
    prepareTrial,
  });
});

export const layer = Layer.effect(ServiceLauncherClient, make());
