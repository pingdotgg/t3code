import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface AntigravityAccountIdentity {
  readonly credentialFingerprint: string;
  readonly credentialEmail?: string;
}

/** A fingerprint alone, from a fallback that never saw Google's user info, or with its email. */
export type AntigravityAccount = string | AntigravityAccountIdentity;

const decodeUserInfoEmail = Schema.decodeUnknownOption(Schema.Struct({ email: Schema.String }));

/** Takes the fingerprint function so this module never imports the probe that imports it. */
export const withAntigravityAccountEmail =
  <E, R>(fingerprintOf: (userInfo: unknown) => Effect.Effect<string, E, R>) =>
  (userInfo: unknown): Effect.Effect<AntigravityAccountIdentity, E, R> =>
    Effect.map(fingerprintOf(userInfo), (credentialFingerprint) => {
      const email = decodeUserInfoEmail(userInfo).pipe(
        Option.map(({ email }) => email.trim()),
        Option.filter((email) => email.length > 0),
        Option.getOrUndefined,
      );
      return email ? { credentialFingerprint, credentialEmail: email } : { credentialFingerprint };
    });

export const antigravityAccountFields = (
  account: AntigravityAccount,
): AntigravityAccountIdentity =>
  typeof account === "string" ? { credentialFingerprint: account } : account;
