import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export const ManagedEndpointCleanupMode = Schema.Literals(["off", "dry-run", "enabled"]);
export type ManagedEndpointCleanupMode = typeof ManagedEndpointCleanupMode.Type;
const decodeManagedEndpointCleanupMode = Schema.decodeUnknownEffect(ManagedEndpointCleanupMode);

export const RELAY_TUNNEL_CLEANUP_MODE = "RELAY_TUNNEL_CLEANUP_MODE";
/** Separate switch for tunnels whose host never registered recovery. */
export const RELAY_LEGACY_TUNNEL_CLEANUP_MODE = "RELAY_LEGACY_TUNNEL_CLEANUP_MODE";

const cleanupModeConfig = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault("off"),
    Config.map((value) => value.trim() || "off"),
    Config.mapEffect((value) =>
      decodeManagedEndpointCleanupMode(value).pipe(
        Effect.mapError((error) => new Config.ConfigError(error)),
      ),
    ),
  );

export const managedEndpointCleanupModeConfig = cleanupModeConfig(RELAY_TUNNEL_CLEANUP_MODE);
export const legacyManagedEndpointCleanupModeConfig = cleanupModeConfig(
  RELAY_LEGACY_TUNNEL_CLEANUP_MODE,
);

/**
 * Overrides the 30-day legacy grace period, in minutes, so the disposable
 * canary stage can exercise legacy cleanup. Ignored on the prod stage.
 */
export const RELAY_LEGACY_TUNNEL_GRACE_MINUTES = "RELAY_LEGACY_TUNNEL_GRACE_MINUTES";

// A zero or negative override would be ignored at runtime, silently leaving
// the canary on the 30-day grace period, so reject it when the deploy reads it.
export const legacyTunnelGraceMinutesConfig = Config.option(
  Config.schema(
    Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
    RELAY_LEGACY_TUNNEL_GRACE_MINUTES,
  ),
);

/** Decodes the grace-period override binding; anything but a positive integer means none. */
export const decodeLegacyTunnelGraceMinutesEnv = (value: unknown): number | undefined => {
  const minutes = typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isInteger(minutes) && minutes > 0 ? minutes : undefined;
};

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
  const graceMinutes = yield* legacyTunnelGraceMinutesConfig;
  return {
    [RELAY_TUNNEL_CLEANUP_MODE]: yield* managedEndpointCleanupModeConfig,
    [RELAY_LEGACY_TUNNEL_CLEANUP_MODE]: yield* legacyManagedEndpointCleanupModeConfig,
    ...(Option.isSome(graceMinutes)
      ? { [RELAY_LEGACY_TUNNEL_GRACE_MINUTES]: String(graceMinutes.value) }
      : {}),
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
    readonly legacyManagedEndpointCleanupMode?: ManagedEndpointCleanupMode;
    /** Canary-only override of the legacy grace period; ignored on prod. */
    readonly legacyTunnelGraceMinutes?: number;
  }
>()("t3code-relay/Config/RelayConfiguration") {}

export const make = (configuration: RelayConfiguration["Service"]) =>
  RelayConfiguration.of(configuration);

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, make(configuration));
