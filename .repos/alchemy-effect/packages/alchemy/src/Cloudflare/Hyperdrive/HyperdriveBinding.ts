import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Hyperdrive } from "./Hyperdrive.ts";
import { defaultPort, type HyperdriveDevOrigin } from "./Hyperdrive.ts";

export interface HyperdriveBindingClient {
  /**
   * The raw runtime `Hyperdrive` binding. Use this when integrating with a
   * driver that wants direct access to the Cloudflare object.
   */
  raw: Effect.Effect<runtime.Hyperdrive, never, RuntimeContext>;
  /**
   * A valid DB connection string for use with a driver/ORM.
   */
  connectionString: Effect.Effect<
    Redacted.Redacted<string>,
    never,
    RuntimeContext
  >;
  /**
   * Hostname valid only within the current Worker invocation.
   */
  host: Effect.Effect<string, never, RuntimeContext>;
  /**
   * Port to pair with `host`.
   */
  port: Effect.Effect<number, never, RuntimeContext>;
  /**
   * Database user.
   */
  user: Effect.Effect<string, never, RuntimeContext>;
  /**
   * Randomly generated password valid only within the current Worker
   * invocation.
   */
  password: Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>;
  /**
   * Database name.
   */
  database: Effect.Effect<string, never, RuntimeContext>;
}

/**
 * A typed accessor for a Cloudflare Hyperdrive runtime binding inside a
 * Worker. Provides the same shape as the raw `Hyperdrive` runtime object
 * (connection string, host, port, user, password, database) plus a `raw`
 * escape hatch for libraries that want direct access.
 *
 * @example Bind Hyperdrive in a Worker
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.bind(MyHyperdrive);
 * const url = yield* hd.connectionString;
 * ```
 *
 * @binding
 */
export class HyperdriveBinding extends Binding.Service<
  HyperdriveBinding,
  (hyperdrive: Hyperdrive) => Effect.Effect<HyperdriveBindingClient>
>()("Cloudflare.Hyperdrive.Binding") {}

export const HyperdriveBindingLive = Layer.effect(
  HyperdriveBinding,
  Effect.gen(function* () {
    const Policy = yield* HyperdriveBindingPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (hyperdrive: Hyperdrive) {
      yield* Policy(hyperdrive);
      const hd = Effect.sync(
        () =>
          (env as Record<string, runtime.Hyperdrive>)[hyperdrive.LogicalId]!,
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
      } satisfies HyperdriveBindingClient;
    });
  }),
);

export class HyperdriveBindingPolicy extends Binding.Policy<
  HyperdriveBindingPolicy,
  (hyperdrive: Hyperdrive) => Effect.Effect<void>
>()("Cloudflare.Hyperdrive.Binding") {}

export const HyperdriveBindingPolicyLive = HyperdriveBindingPolicy.layer.effect(
  Effect.gen(function* () {
    return Effect.fn(function* (host: ResourceLike, hyperdrive: Hyperdrive) {
      if (!isWorker(host)) {
        return yield* Effect.die(
          new Error(
            `HyperdriveBinding does not support runtime '${host.Type}'`,
          ),
        );
      }

      yield* host.bind`${hyperdrive}`({
        bindings: [
          {
            type: "hyperdrive",
            name: hyperdrive.LogicalId,
            id: hyperdrive.hyperdriveId as unknown as string,
          },
        ],
        hyperdrives: getHyperdriveDevOrigin(hyperdrive),
      });
    });
  }),
);

export const getHyperdriveDevOrigin = (hyperdrive: Hyperdrive) => {
  const origin = Output.map(
    Output.all(hyperdrive.dev, hyperdrive.origin, hyperdrive.mtls),
    ([dev, origin, mtls]): Required<HyperdriveDevOrigin> => {
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
          `Hyperdrive instance ${hyperdrive.LogicalId} has an origin that requires Cloudflare Access. This is not supported in development mode. ` +
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
    Output.all(hyperdrive.hyperdriveId, Output.asOutput(origin)),
    ([id, origin]) => ({
      [id]: origin,
    }),
  ) as unknown as Record<string, Required<HyperdriveDevOrigin>>;
};
