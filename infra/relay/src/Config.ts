import * as Context from "effect/Context";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

export interface RelayConfigurationShape {
  readonly relayIssuer: string;
  readonly apns: ApnsCredentials;
  readonly clerkSecretKey: Redacted.Redacted<string>;
  readonly clerkPublishableKey: string;
  readonly clerkJwtAudience: string;
  readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
  readonly cloudMintPrivateKey: Redacted.Redacted<string>;
  readonly cloudMintPublicKey: string;
  readonly managedEndpointBaseDomain: string | undefined;
  readonly managedEndpointNamespace: string | undefined;
}

export class RelayConfiguration extends Context.Service<
  RelayConfiguration,
  RelayConfigurationShape
>()("t3code-relay/Config/RelayConfiguration") {}
