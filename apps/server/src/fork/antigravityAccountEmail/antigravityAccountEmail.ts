import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface AntigravityAccountIdentity {
  readonly credentialFingerprint: string;
  readonly credentialEmail?: string;
}

const decodeUserInfoEmail = Schema.decodeUnknownOption(Schema.Struct({ email: Schema.String }));

export function withAntigravityAccountEmail(
  credentialFingerprint: string,
  userInfo: unknown,
): AntigravityAccountIdentity {
  const email = decodeUserInfoEmail(userInfo).pipe(
    Option.map(({ email }) => email.trim()),
    Option.filter((email) => email.length > 0),
    Option.getOrUndefined,
  );
  return email ? { credentialFingerprint, credentialEmail: email } : { credentialFingerprint };
}
