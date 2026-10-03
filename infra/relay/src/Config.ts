import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export const ManagedEndpointCleanupMode = Schema.Literals(["off", "dry-run", "enabled"]);
export type ManagedEndpointCleanupMode = typeof ManagedEndpointCleanupMode.Type;
const decodeManagedEndpointCleanupMode = Schema.decodeUnknownEffect(ManagedEndpointCleanupMode);

export const RELAY_TUNNEL_CLEANUP_MODE = "RELAY_TUNNEL_CLEANUP_MODE";

export const managedEndpointCleanupModeConfig = Config.String(RELAY_TUNNEL_CLEANUP_MODE).pipe(
  Config.withDefault("off"),
  Config.map((value) => value.trim() || "off"),
  Config.mapEffect((value) =>
    decodeManagedEndpointCleanupMode(value).pipe(
      Effect.mapError((error) => new Config.ConfigError(error)),
    ),
  ),
);

/** Decodes a cleanup mode binding; a missing or blank binding means `off`. */
export const decodeManagedEndpointCleanupModeEnv = (value: unknown) =>
  decodeManagedEndpointCleanupMode(
    typeof value === "string" && value.trim() !== "" ? value.trim() : "off",
  );

/**
 * Cleanup modes as plain Worker `env` entries. Alchemy compares declared
 * `env` bindings when it decides whether the Worker changed, but not values
 * read through `Config` in Init (alchemy-run/alchemy#1831), so a mode read
 * only in Init would need a forced deploy to change.
 */
export const managedEndpointCleanupModeEnv = Effect.gen(function* () {
  return {
    [RELAY_TUNNEL_CLEANUP_MODE]: yield* managedEndpointCleanupModeConfig,
  };
});

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

export class RelayConfiguration extends Context.Service<
  RelayConfiguration,
  {
    readonly relayIssuer: string;
    readonly apns: ApnsCredentials | null;
    readonly fcmServiceAccount?: Redacted.Redacted<string>;
    readonly clerkSecretKey: Redacted.Redacted<string>;
    readonly clerkPublishableKey: string;
    readonly clerkJwtAudience: string;
    readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
    readonly cloudMintPrivateKey: Redacted.Redacted<string>;
    readonly cloudMintPublicKey: string;
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
    readonly managedEndpointCleanupMode?: ManagedEndpointCleanupMode;
  }
>()("t3code-relay/Config/RelayConfiguration") {}

export const make = (configuration: RelayConfiguration["Service"]) =>
  RelayConfiguration.of(configuration);

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, make(configuration));
