import type { ServerSelfUpdateOutcome } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  isExactServiceVersion,
  type PendingServiceUpdate,
  type ServiceLauncherChildMessage,
  type ServiceLauncherContext,
  type ServiceLauncherParentMessage,
  type ServiceUpdateRecord,
} from "./serviceProtocol.ts";

export class ServiceLauncherClientError extends Schema.TaggedErrorClass<ServiceLauncherClientError>()(
  "ServiceLauncherClientError",
  {
    operation: Schema.Literals([
      "decode-context",
      "version-mismatch",
      "ipc-unavailable",
      "unmanaged",
      "send",
      "disconnect",
      "rejected",
    ]),
    launcherVersion: Schema.optional(Schema.String),
    childVersion: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "decode-context":
        return "The service launcher supplied invalid startup context.";
      case "version-mismatch":
        return `The service launcher started t3@${this.launcherVersion ?? "unknown"}, but the child reports t3@${this.childVersion ?? "unknown"}.`;
      case "ipc-unavailable":
        return "The service launcher IPC channel is unavailable.";
      case "unmanaged":
        return "This server is not managed by the launcher.";
      case "send":
        return "Could not send a request to the service launcher.";
      case "disconnect":
        return "The service launcher disconnected before acknowledging the request.";
      case "rejected":
        return this.detail ?? "The service launcher rejected the request.";
    }
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

export const ServiceLauncherTrial = Context.Reference<boolean>("t3/cloud/serviceLauncherTrial", {
  defaultValue: () => false,
});

export const isServiceLauncherManaged = Effect.fn("cloud.service_launcher_client.is_managed")(
  function* (currentVersion = packageJson.version) {
    const host = yield* ServiceLauncherHostProcess;
    const environment = yield* HostProcessEnvironment;
    const raw = environment[SERVICE_LAUNCHER_CONTEXT_ENV];
    const context = raw === undefined ? undefined : decodeContext(raw);
    return context?.childVersion === currentVersion && host.connected;
  },
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isTerminalUpdate = (value: ServiceUpdateRecord): value is ServerSelfUpdateOutcome =>
  value.status !== "pending";

function decodeUpdate(value: unknown): ServiceUpdateRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    value.id.trim() === "" ||
    typeof value.fromVersion !== "string" ||
    !isExactServiceVersion(value.fromVersion) ||
    typeof value.targetVersion !== "string" ||
    !isExactServiceVersion(value.targetVersion) ||
    typeof value.status !== "string"
  ) {
    return undefined;
  }
  if (
    value.status === "pending" &&
    typeof value.requestedAt === "string" &&
    !Number.isNaN(Date.parse(value.requestedAt))
  ) {
    return {
      id: value.id,
      fromVersion: value.fromVersion,
      targetVersion: value.targetVersion,
      status: "pending",
      requestedAt: value.requestedAt,
    };
  }
  if (
    (value.status === "committed" || value.status === "rolled-back" || value.status === "failed") &&
    typeof value.completedAt === "string" &&
    !Number.isNaN(Date.parse(value.completedAt)) &&
    (value.reason === undefined || (typeof value.reason === "string" && value.reason.trim() !== ""))
  ) {
    return {
      id: value.id,
      fromVersion: value.fromVersion,
      targetVersion: value.targetVersion,
      status: value.status,
      completedAt: value.completedAt,
      ...(value.reason === undefined ? {} : { reason: value.reason }),
    };
  }
  return undefined;
}

function decodeContext(raw: string): ServiceLauncherContext | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.protocol !== SERVICE_LAUNCHER_PROTOCOL ||
    typeof value.activeVersion !== "string" ||
    !isExactServiceVersion(value.activeVersion) ||
    typeof value.childVersion !== "string" ||
    !isExactServiceVersion(value.childVersion) ||
    typeof value.trial !== "boolean"
  ) {
    return undefined;
  }
  const update = value.update === undefined ? undefined : decodeUpdate(value.update);
  if (value.update !== undefined && update === undefined) return undefined;
  const context: ServiceLauncherContext = {
    protocol: SERVICE_LAUNCHER_PROTOCOL,
    activeVersion: value.activeVersion,
    childVersion: value.childVersion,
    trial: value.trial,
    ...(update === undefined ? {} : { update }),
  };
  if (context.trial) {
    return context.update?.status === "pending" &&
      context.activeVersion === context.update.fromVersion &&
      context.childVersion === context.update.targetVersion
      ? context
      : undefined;
  }
  if (context.update?.status === "pending") return undefined;
  const selectedVersion =
    context.update?.status === "committed"
      ? context.update.targetVersion
      : context.update === undefined
        ? context.activeVersion
        : context.update.fromVersion;
  return context.activeVersion === selectedVersion && context.childVersion === selectedVersion
    ? context
    : undefined;
}

function decodeParentMessage(value: unknown): ServiceLauncherParentMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "update-rejected" && typeof value.reason === "string") {
    return { type: "update-rejected", reason: value.reason };
  }
  const update = decodeUpdate(value.update);
  if (value.type === "update-accepted" && update?.status === "pending") {
    return { type: "update-accepted", update };
  }
  if (value.type === "committed" && update?.status === "committed") {
    return { type: "committed", update: { ...update, status: "committed" } };
  }
  return undefined;
}

export class ServiceLauncherClient extends Context.Service<
  ServiceLauncherClient,
  {
    readonly managed: boolean;
    readonly trial: boolean;
    readonly awaitActivation: Effect.Effect<void, ServiceLauncherClientError>;
    readonly requestUpdate: (input: {
      readonly fromVersion: string;
      readonly targetVersion: string;
    }) => Effect.Effect<PendingServiceUpdate, ServiceLauncherClientError>;
    readonly prepareTrial: Effect.Effect<
      Option.Option<ServerSelfUpdateOutcome>,
      ServiceLauncherClientError
    >;
    readonly latestOutcome: Effect.Effect<Option.Option<ServerSelfUpdateOutcome>>;
  }
>()("t3/cloud/serviceLauncherClient") {}

export const make = Effect.fn("cloud.service_launcher_client.make")(function* (options?: {
  readonly currentVersion?: string;
}) {
  const host = yield* ServiceLauncherHostProcess;
  const environment = yield* HostProcessEnvironment;
  const currentVersion = options?.currentVersion ?? packageJson.version;
  const rawContext = environment[SERVICE_LAUNCHER_CONTEXT_ENV];
  const context = rawContext === undefined ? undefined : decodeContext(rawContext);

  if (rawContext !== undefined && context === undefined) {
    return yield* new ServiceLauncherClientError({
      operation: "decode-context",
    });
  }
  if (context !== undefined && context.childVersion !== currentVersion) {
    return yield* new ServiceLauncherClientError({
      operation: "version-mismatch",
      launcherVersion: context.childVersion,
      childVersion: currentVersion,
    });
  }

  const managed = context !== undefined && host.connected;
  if (context !== undefined && !managed) {
    return yield* new ServiceLauncherClientError({
      operation: "ipc-unavailable",
    });
  }

  const activation = yield* Deferred.make<void, ServiceLauncherClientError>();
  if (context?.trial !== true) {
    yield* Deferred.succeed(activation, undefined).pipe(Effect.orDie);
  }
  const initialOutcome =
    context?.update !== undefined && isTerminalUpdate(context.update)
      ? Option.some(context.update)
      : Option.none<ServerSelfUpdateOutcome>();
  const outcome = yield* Ref.make(initialOutcome);

  const exchange = (
    message: ServiceLauncherChildMessage,
    accept: (reply: ServiceLauncherParentMessage) => boolean,
  ) =>
    Effect.callback<ServiceLauncherParentMessage, ServiceLauncherClientError>((resume) => {
      if (!managed) {
        resume(
          Effect.fail(
            new ServiceLauncherClientError({
              operation: "unmanaged",
            }),
          ),
        );
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
        const reply = decodeParentMessage(args[0]);
        if (reply !== undefined && accept(reply)) settle(Effect.succeed(reply));
      };
      const onDisconnect = () =>
        settle(
          Effect.fail(
            new ServiceLauncherClientError({
              operation: "disconnect",
            }),
          ),
        );

      host.on("message", onMessage);
      host.on("disconnect", onDisconnect);
      try {
        host.send(message, (error) => {
          if (error !== null) {
            settle(
              Effect.fail(
                new ServiceLauncherClientError({
                  operation: "send",
                  cause: error,
                }),
              ),
            );
          }
        });
      } catch (cause) {
        settle(
          Effect.fail(
            new ServiceLauncherClientError({
              operation: "send",
              cause,
            }),
          ),
        );
      }

      return Effect.sync(cleanup);
    });

  const requestUpdate = (input: { readonly fromVersion: string; readonly targetVersion: string }) =>
    exchange(
      { type: "request-update", ...input },
      (reply) => reply.type === "update-accepted" || reply.type === "update-rejected",
    ).pipe(
      Effect.flatMap((reply) =>
        reply.type === "update-accepted"
          ? Effect.succeed(reply.update)
          : reply.type === "update-rejected"
            ? Effect.fail(
                new ServiceLauncherClientError({ operation: "rejected", detail: reply.reason }),
              )
            : Effect.die("service launcher returned an impossible update response"),
      ),
    );

  const prepareTrial =
    context?.trial === true && context.update?.status === "pending"
      ? exchange(
          { type: "prepared", updateId: context.update.id },
          (reply) => reply.type === "committed" && reply.update.id === context.update?.id,
        ).pipe(
          Effect.flatMap((reply) => {
            if (reply.type !== "committed") {
              return Effect.die("service launcher returned an impossible prepared response");
            }
            return Ref.set(outcome, Option.some(reply.update)).pipe(
              Effect.andThen(Deferred.succeed(activation, undefined).pipe(Effect.orDie)),
              Effect.as(Option.some(reply.update)),
            );
          }),
        )
      : Ref.get(outcome);

  return ServiceLauncherClient.of({
    managed,
    trial: context?.trial === true,
    awaitActivation: Deferred.await(activation),
    requestUpdate,
    prepareTrial,
    latestOutcome: Ref.get(outcome),
  });
});

export const layer: Layer.Layer<ServiceLauncherClient, ServiceLauncherClientError> = Layer.effect(
  ServiceLauncherClient,
  make(),
);
