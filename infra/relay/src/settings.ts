import * as Context from "effect/Context";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export interface ApnsCredentials {
  readonly teamId: Redacted.Redacted<string>;
  readonly keyId: Redacted.Redacted<string>;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: Redacted.Redacted<string>;
  readonly environment: ApnsEnvironment;
}

export interface SettingsShape {
  readonly relayIssuer: string;
  readonly apns: ApnsCredentials;
  readonly clerkSecretKey: Redacted.Redacted<string>;
  readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
  readonly cloudMintPrivateKey: Redacted.Redacted<string>;
  readonly cloudMintPublicKey: Redacted.Redacted<string>;
  readonly managedEndpointBaseDomain: string | undefined;
  readonly cloudflareAccountId: Redacted.Redacted<string> | undefined;
  readonly cloudflareZoneId: Redacted.Redacted<string> | undefined;
  readonly cloudflareApiToken: Redacted.Redacted<string> | undefined;
}

export class Settings extends Context.Service<Settings, SettingsShape>()("Settings") {}
