import type { ServerSelfUpdateOutcome } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import {
  decodeServiceLauncherContext,
  decodeServiceLauncherParentMessage,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  type ServiceLauncherChildMessage,
  type ServiceLauncherParentMessage,
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
      "timeout",
      "rejected",
    ]),
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
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

export class ServiceLauncherClient extends Context.Reference<{
  readonly managed: boolean;
  readonly trial: boolean;
  readonly requestUpdate: (input: {
    readonly targetVersion: string;
  }) => Effect.Effect<string, ServiceLauncherClientError>;
  readonly prepareTrial: Effect.Effect<
    ServerSelfUpdateOutcome | undefined,
    ServiceLauncherClientError
  >;
}>("t3/cloud/serviceLauncherClient", {
  defaultValue: () => ({
    managed: false,
    trial: false,
    requestUpdate: () =>
      Effect.fail(
        new ServiceLauncherClientError({
          operation: "unmanaged",
          reason: "This server is not managed by the launcher.",
        }),
      ),
    prepareTrial: Effect.sync((): undefined => undefined),
  }),
}) {}

export const make = Effect.fn("cloud.service_launcher_client.make")(function* (options?: {
  readonly currentVersion?: string;
}) {
  const host = yield* ServiceLauncherHostProcess;
  const environment = yield* HostProcessEnvironment;
  const currentVersion = options?.currentVersion ?? packageJson.version;
  const rawContext = environment[SERVICE_LAUNCHER_CONTEXT_ENV];
  const context = rawContext === undefined ? undefined : decodeServiceLauncherContext(rawContext);
  const fail = (
    operation: ServiceLauncherClientError["operation"],
    reason: string,
    cause?: unknown,
  ) =>
    cause === undefined
      ? new ServiceLauncherClientError({ operation, reason })
      : new ServiceLauncherClientError({ operation, reason, cause });

  if (rawContext !== undefined && context === undefined) {
    return yield* fail("decode-context", "The service launcher supplied invalid startup context.");
  }
  if (context !== undefined && context.childVersion !== currentVersion) {
    return yield* fail(
      "version-mismatch",
      `The service launcher started t3@${context.childVersion}, but the child reports t3@${currentVersion}.`,
    );
  }

  const managed = context !== undefined && host.connected;
  if (context !== undefined && !managed) {
    return yield* fail("ipc-unavailable", "The service launcher IPC channel is unavailable.");
  }

  const exchange = (
    message: ServiceLauncherChildMessage,
    accept: (reply: ServiceLauncherParentMessage) => boolean,
  ) =>
    Effect.callback<ServiceLauncherParentMessage, ServiceLauncherClientError>((resume) => {
      if (!managed) {
        resume(Effect.fail(fail("unmanaged", "This server is not managed by the launcher.")));
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
        settle(
          Effect.fail(
            fail(
              "disconnect",
              "The service launcher disconnected before acknowledging the request.",
            ),
          ),
        );

      host.on("message", onMessage);
      host.on("disconnect", onDisconnect);
      try {
        host.send(message, (error) => {
          if (error !== null) {
            settle(
              Effect.fail(fail("send", "Could not send a request to the service launcher.", error)),
            );
          }
        });
      } catch (cause) {
        settle(
          Effect.fail(fail("send", "Could not send a request to the service launcher.", cause)),
        );
      }

      return Effect.sync(cleanup);
    }).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(fail("timeout", "The service launcher did not respond within 30 seconds.")),
      }),
    );

  const requestUpdate = (input: { readonly targetVersion: string }) =>
    exchange(
      { type: "request-update", ...input },
      (reply) => reply.type === "update-accepted" || reply.type === "update-rejected",
    ).pipe(
      Effect.flatMap((reply) =>
        reply.type === "update-accepted"
          ? Effect.succeed(reply.updateId)
          : reply.type === "update-rejected"
            ? Effect.fail(fail("rejected", reply.reason))
            : Effect.die("service launcher returned an impossible update response"),
      ),
    );

  const pending = context?.update?.status === "pending" ? context.update : undefined;
  const outcome =
    context?.update === undefined || context.update.status === "pending"
      ? undefined
      : context.update;
  const prepareTrial =
    pending !== undefined
      ? exchange(
          { type: "prepared", updateId: pending.id },
          (reply) => reply.type === "committed" && reply.updateId === pending.id,
        ).pipe(
          Effect.flatMap((reply) => {
            if (reply.type !== "committed") {
              return Effect.die("service launcher returned an impossible prepared response");
            }
            return Effect.succeed({ ...pending, status: "committed" as const });
          }),
        )
      : Effect.succeed(outcome);

  return ServiceLauncherClient.of({
    managed,
    trial: pending !== undefined,
    requestUpdate,
    prepareTrial,
  });
});
