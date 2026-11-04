import * as hyperdrive from "@distilled.cloud/cloudflare/hyperdrive";
import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { DevOrigin } from "./Connection.ts";

export type ConnectionLookupProps = (
  | {
      /**
       * The Cloudflare-assigned ID of the existing Hyperdrive configuration.
       */
      hyperdriveId: string;
    }
  | {
      /**
       * The name of the existing Hyperdrive configuration.
       */
      name: string;
    }
) & {
  /**
   * Local development origin. The Cloudflare API never returns the origin
   * password of an existing configuration, so `alchemy dev` can only
   * emulate the binding when a `dev` origin is set. Without it, a locally
   * running Worker that binds the lookup fails with
   * `HyperdriveDevOriginUnsupported`.
   */
  dev?: DevOrigin | Output.Output<DevOrigin>;
};

const ConnectionLookupTypeId = Symbol.for("alchemy/Cloudflare/Hyperdrive/ConnectionLookup");

/**
 * The value of a {@link lookup}: a binding descriptor branded with the
 * Hyperdrive resource `Type`, so Worker binding classification and
 * {@link Connect} treat it exactly like a managed {@link Connection}.
 */
export interface ConnectionLookup {
  readonly [ConnectionLookupTypeId]: true;
  readonly Type: "Cloudflare.Hyperdrive";
  /**
   * The id passed to {@link lookup}; {@link Connect} uses it as the Worker
   * binding name.
   */
  readonly LogicalId: string;
  /** Cloudflare-assigned ID of the configuration. */
  readonly hyperdriveId: Output.Output<string>;
  /** Name of the configuration. */
  readonly name: Output.Output<string>;
  /** Account the configuration lives in. */
  readonly accountId: Output.Output<string>;
  /** The `dev` origin passed to {@link lookup}. */
  readonly dev: Output.Output<DevOrigin | undefined>;
}

export const isConnectionLookup = (value: unknown): value is ConnectionLookup =>
  typeof value === "object" && value !== null && ConnectionLookupTypeId in value;

/**
 * No Hyperdrive configuration with the looked-up name exists in the account.
 */
export class HyperdriveConfigLookupNotFound extends Data.TaggedError(
  "HyperdriveConfigLookupNotFound",
)<{
  message: string;
  configName: string;
  accountId: string;
}> {}

/**
 * Look up an existing Cloudflare Hyperdrive configuration (created in the
 * dashboard or owned by another system) without managing its lifecycle —
 * the data-source form (what Terraform calls a data source and Pulumi an
 * invoke). The configuration is read by `hyperdriveId` or `name` during
 * plan/deploy and is never created, updated or deleted: there is no state
 * row, so `destroy` and `nuke` cannot touch it. Bind it to a Worker through
 * `env` or {@link Connect}, exactly like a {@link Connection}.
 *
 * The `id` names the binding inside the Worker, so it must be the same on
 * every deploy; the `name` or `hyperdriveId` may differ per stage.
 *
 * ### Looking up a configuration
 * **Example:** By ID
 * ```typescript
 * const db = Cloudflare.Hyperdrive.lookup("SharedDb", {
 *   hyperdriveId: "a76a99bc342644deb02c38d66082262a",
 * });
 * ```
 *
 * **Example:** By name
 * ```typescript
 * const db = Cloudflare.Hyperdrive.lookup("SharedDb", {
 *   name: "shared-postgres",
 * });
 * ```
 *
 * ### Binding to a Worker
 * **Example:** Async Worker `env`
 * ```typescript
 * const worker = yield* Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: {
 *     HD: Cloudflare.Hyperdrive.lookup("SharedDb", { name: "shared-postgres" }),
 *   },
 * });
 * ```
 *
 * **Example:** Effect Worker
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.Connect(
 *   Cloudflare.Hyperdrive.lookup("SharedDb", { name: "shared-postgres" }),
 * );
 * const url = yield* hd.connectionString;
 * ```
 *
 * ### Local development
 * **Example:** Dev origin for `alchemy dev`
 * ```typescript
 * const db = Cloudflare.Hyperdrive.lookup("SharedDb", {
 *   name: "shared-postgres",
 *   dev: {
 *     scheme: "postgres",
 *     host: "localhost",
 *     port: 5432,
 *     database: "app",
 *     user: "postgres",
 *     password: yield* Config.redacted("DEV_DB_PASSWORD"),
 *   },
 * });
 * ```
 *
 * @resource
 * @product Hyperdrive
 * @category Storage & Databases
 */
export const lookup = (id: string, props: ConnectionLookupProps): ConnectionLookup => {
  const config = Output.fromEffect(
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ("hyperdriveId" in props) {
        const config = yield* hyperdrive.getConfig({
          accountId,
          hyperdriveId: props.hyperdriveId,
        });
        return { hyperdriveId: config.id, name: config.name, accountId };
      }
      const match = yield* hyperdrive.listConfigs.items({ accountId }).pipe(
        Stream.filter((c) => c.name === props.name),
        Stream.runHead,
        Effect.map(Option.getOrUndefined),
      );
      if (!match) {
        return yield* Effect.die(
          new HyperdriveConfigLookupNotFound({
            configName: props.name,
            accountId,
            message: `Hyperdrive configuration "${props.name}" not found in account ${accountId}`,
          }),
        );
      }
      return { hyperdriveId: match.id, name: match.name, accountId };
    }).pipe(Effect.orDie),
  );
  return {
    [ConnectionLookupTypeId]: true,
    Type: "Cloudflare.Hyperdrive",
    LogicalId: id,
    hyperdriveId: Output.map(config, (c) => c.hyperdriveId),
    name: Output.map(config, (c) => c.name),
    accountId: Output.map(config, (c) => c.accountId),
    dev: Output.asOutput<DevOrigin | undefined>(props.dev),
  };
};
