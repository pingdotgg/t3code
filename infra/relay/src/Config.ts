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

const RELAY_TUNNEL_CLEANUP_MODE = "RELAY_TUNNEL_CLEANUP_MODE";
const RELAY_LEGACY_TUNNEL_CLEANUP_MODE = "RELAY_LEGACY_TUNNEL_CLEANUP_MODE";

// Workflows pass an unset variable as "", so blank means the default.
export const literalConfig = <const Literals extends ReadonlyArray<string>>(
  name: string,
  schema: Schema.Literals<Literals>,
  fallback: Literals[number],
) =>
  Config.String(name).pipe(
    Config.withDefault(fallback),
    Config.map((value) => value.trim() || fallback),
    Config.mapEffect((value) =>
      Schema.decodeEffect(schema)(value).pipe(
        Effect.mapError((error) => new Config.ConfigError(error)),
      ),
    ),
  );

const cleanupModeConfig = (name: string) => literalConfig(name, ManagedEndpointCleanupMode, "off");

export const managedEndpointCleanupModeConfig = cleanupModeConfig(RELAY_TUNNEL_CLEANUP_MODE);
export const legacyManagedEndpointCleanupModeConfig = cleanupModeConfig(
  RELAY_LEGACY_TUNNEL_CLEANUP_MODE,
);

export const RelayObservabilityMode = Schema.Literals(["axiom", "off"]);
export type RelayObservabilityMode = typeof RelayObservabilityMode.Type;

/** `off` deploys no Axiom datasets, tokens, or R2 source-map bucket, and the relay exports no spans. */
export const relayObservabilityConfig = literalConfig(
  "RELAY_OBSERVABILITY",
  RelayObservabilityMode,
  "axiom",
);

export const RelayRateLimitMode = Schema.Literals(["cloudflare", "off"]);
export type RelayRateLimitMode = typeof RelayRateLimitMode.Type;

/** `off` drops the Workers Rate Limiting bindings and allows every hook and telemetry request. */
export const relayRateLimitConfig = literalConfig(
  "RELAY_RATE_LIMIT",
  RelayRateLimitMode,
  "cloudflare",
);

const RELAY_LEGACY_TUNNEL_GRACE_MINUTES = "RELAY_LEGACY_TUNNEL_GRACE_MINUTES";

export const legacyTunnelGraceMinutesConfig = Config.option(
  Config.schema(
    Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
    RELAY_LEGACY_TUNNEL_GRACE_MINUTES,
  ),
);

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

export interface T3ChatSettings {
  readonly baseUrl: string;
  // Shared with T3 Chat: signs link tokens and authenticates relay calls.
  readonly linkSecret: Redacted.Redacted<string>;
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
    readonly legacyTunnelGraceMinutes?: number;
    readonly t3Chat?: T3ChatSettings;
  }
>()("t3code-relay/Config/RelayConfiguration") {}

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, RelayConfiguration.of(configuration));
