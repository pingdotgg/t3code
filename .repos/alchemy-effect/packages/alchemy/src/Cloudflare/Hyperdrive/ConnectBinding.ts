import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Output from "../../Output.ts";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import { Connect, type ConnectClient } from "./Connect.ts";
import type { Connection } from "./Connection.ts";
import { defaultPort, type DevOrigin } from "./Connection.ts";

export const ConnectBinding = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (connection: Connection) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${connection}`({
          bindings: [
            {
              type: "hyperdrive",
              name: connection.LogicalId,
              id: connection.hyperdriveId as unknown as string,
            },
          ],
          hyperdrives: getHyperdriveDevOrigin(connection),
        });
      }

      const hd = Effect.sync(
        () =>
          (env as Record<string, runtime.Hyperdrive>)[connection.LogicalId]!,
      );

      return {
        raw: hd,
        connectionString: hd.pipe(
          Effect.map((hd) => Redacted.make(hd.connectionString)),
        ),
        host: hd.pipe(Effect.map((hd) => hd.host)),
        port: hd.pipe(Effect.map((hd) => hd.port)),
        user: hd.pipe(Effect.map((hd) => hd.user)),
        password: hd.pipe(Effect.map((hd) => Redacted.make(hd.password))),
        database: hd.pipe(Effect.map((hd) => hd.database)),
      } satisfies ConnectClient;
    });
  }),
);

export const getHyperdriveDevOrigin = (connection: Connection) => {
  const origin = Output.map(
    Output.all(connection.dev, connection.origin, connection.mtls),
    ([dev, origin, mtls]): Required<DevOrigin> => {
      if (dev) {
        return {
          scheme: dev.scheme,
          host: dev.host,
          port: dev.port ?? defaultPort(dev.scheme),
          user: dev.user,
          database: dev.database,
          password: dev.password,
          sslmode: dev.sslmode ?? "prefer",
        };
      }
      if ("accessClientId" in origin) {
        throw new Error(
          `Hyperdrive instance ${connection.LogicalId} has an origin that requires Cloudflare Access. This is not supported in development mode. ` +
            "Select a different origin or set the `dev` property to an origin that does not require Cloudflare Access.",
        );
      }
      return {
        scheme: origin.scheme,
        host: origin.host,
        port: origin.port ?? defaultPort(origin.scheme),
        user: origin.user,
        database: origin.database,
        password: origin.password,
        sslmode: mtls?.sslmode ?? "require",
      };
    },
  );
  return Output.map(
    Output.all(connection.hyperdriveId, Output.asOutput(origin)),
    ([id, origin]) => ({
      [id]: origin,
    }),
  ) as unknown as Record<string, Required<DevOrigin>>;
};
