import type * as runtime from "@cloudflare/workers-types";
import * as Output from "alchemy/Output";
import { defaultProviderMode, type ProviderMode } from "alchemy/ProviderMode";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import { Connect, type ConnectClient } from "./Connect.ts";
import type { Connection } from "./Connection.ts";
import { defaultPort, type DevOrigin, type Mtls, type Origin } from "./Connection.ts";
import { type ConnectionLookup, isConnectionLookup } from "./ConnectionLookup.ts";

export const ConnectBinding = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (connection: Connection | ConnectionLookup) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${connection}`({
          bindings: [
            {
              type: "hyperdrive",
              name: connection.LogicalId,
              id: connection.hyperdriveId as unknown as string,
            },
          ],
          hyperdrives: yield* getHyperdriveDevOriginForHost(connection, host),
        });
      }

      const hd = Effect.sync(
        () => (env as Record<string, runtime.Hyperdrive>)[connection.LogicalId]!,
      );

      return {
        raw: hd,
        connectionString: hd.pipe(Effect.map((hd) => Redacted.make(hd.connectionString))),
        host: hd.pipe(Effect.map((hd) => hd.host)),
        port: hd.pipe(Effect.map((hd) => hd.port)),
        user: hd.pipe(Effect.map((hd) => hd.user)),
        password: hd.pipe(Effect.map((hd) => Redacted.make(hd.password))),
        database: hd.pipe(Effect.map((hd) => hd.database)),
      } satisfies ConnectClient;
    });
  }),
);

/**
 * The `hyperdrives` dev channel for `connection` bound to `host`. Only the
 * local worker provider reads it, so it is contributed only when the host
 * runs locally — its registration-captured `Mode` (`Alchemy.remote()` →
 * `"live"`) or the run default (`alchemy dev` → `"local"`), the same
 * resolution the planner applies to the host. A live host (`alchemy deploy`,
 * or a `remote()` worker in dev) never evaluates the dev origin, so an
 * Access-protected origin without a `dev` override deploys.
 */
export const getHyperdriveDevOriginForHost = Effect.fn(function* (
  connection: Connection | ConnectionLookup,
  host: { readonly Mode?: ProviderMode | undefined },
) {
  const mode = host.Mode ?? (yield* defaultProviderMode);
  return mode === "local" ? getHyperdriveDevOrigin(connection) : undefined;
});

/**
 * A Hyperdrive origin that `alchemy dev` cannot reach from the local
 * machine, bound without a `dev` override.
 */
export class HyperdriveDevOriginUnsupported extends Data.TaggedError(
  "HyperdriveDevOriginUnsupported",
)<{
  message: string;
  logicalId: string;
  origin: "access" | "vpc" | "lookup";
}> {}

const toDevOrigin = (dev: DevOrigin): Required<DevOrigin> => ({
  scheme: dev.scheme,
  host: dev.host,
  port: dev.port ?? defaultPort(dev.scheme),
  user: dev.user,
  database: dev.database,
  password: dev.password,
  sslmode: dev.sslmode ?? "prefer",
});

export const getHyperdriveDevOrigin = (connection: Connection | ConnectionLookup) =>
  isConnectionLookup(connection)
    ? getLookupDevOrigin(connection)
    : getConnectionDevOrigin(connection);

/**
 * A looked-up configuration's origin password is never returned by the
 * Cloudflare API, so only its `dev` origin can be emulated locally.
 */
const getLookupDevOrigin = (lookup: ConnectionLookup) =>
  Output.map(
    Output.all(
      lookup.hyperdriveId,
      lookup.dev.pipe(
        Output.mapEffect((dev: DevOrigin | undefined) =>
          dev
            ? Effect.succeed(toDevOrigin(dev))
            : Effect.die(
                new HyperdriveDevOriginUnsupported({
                  logicalId: lookup.LogicalId,
                  origin: "lookup",
                  message:
                    "A Hyperdrive.lookup(...) configuration cannot be emulated in development mode without a `dev` origin: " +
                    "the Cloudflare API never returns the origin password of an existing configuration. " +
                    "Set the `dev` property to an origin reachable from your machine.",
                }),
              ),
        ),
        Output.asOutput,
      ),
    ),
    ([id, origin]) => ({ [id]: origin }),
  ) as unknown as Record<string, Required<DevOrigin>>;

const getConnectionDevOrigin = (connection: Connection) => {
  const origin = Output.mapEffect(([dev, origin, mtls]: [DevOrigin | undefined, Origin, Mtls]) => {
    if (dev) {
      return Effect.succeed(toDevOrigin(dev));
    }
    if ("accessClientId" in origin) {
      return Effect.die(
        new HyperdriveDevOriginUnsupported({
          logicalId: connection.LogicalId,
          origin: "access",
          message:
            `Hyperdrive instance ${connection.LogicalId} has an origin that requires Cloudflare Access. This is not supported in development mode. ` +
            "Select a different origin or set the `dev` property to an origin that does not require Cloudflare Access.",
        }),
      );
    }
    if ("serviceId" in origin) {
      return Effect.die(
        new HyperdriveDevOriginUnsupported({
          logicalId: connection.LogicalId,
          origin: "vpc",
          message:
            `Hyperdrive instance ${connection.LogicalId} has an origin that is reached through a Workers VPC Service. This is not supported in development mode. ` +
            "Set the `dev` property to an origin reachable from your machine.",
        }),
      );
    }
    return Effect.succeed<Required<DevOrigin>>({
      scheme: origin.scheme,
      host: origin.host,
      port: origin.port ?? defaultPort(origin.scheme),
      user: origin.user,
      database: origin.database,
      password: origin.password,
      sslmode: mtls?.sslmode ?? "require",
    });
  })(Output.all(connection.dev, connection.origin, connection.mtls));
  return Output.map(
    Output.all(connection.hyperdriveId, Output.asOutput(origin)),
    ([id, origin]) => ({
      [id]: origin,
    }),
  ) as unknown as Record<string, Required<DevOrigin>>;
};
