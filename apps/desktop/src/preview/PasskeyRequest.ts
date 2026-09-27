// @effect-diagnostics nodeBuiltinImport:off - RP IDs use the same IDNA conversion as browser hostnames.
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import { getDomain } from "tldts";

const Binary = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
  Schema.makeFilter((value) => Buffer.from(value, "base64url").toString("base64url") === value),
);
const Verification = Schema.Literals(["required", "preferred", "discouraged"]);
const Descriptor = Schema.Struct({ type: Schema.Literal("public-key"), id: Binary });
const Extensions = Schema.Struct({
  appid: Schema.optional(Schema.String),
  largeBlob: Schema.optional(Schema.Struct({ support: Schema.optional(Schema.String) })),
  credProps: Schema.optional(Schema.Boolean),
});
const Common = {
  challenge: Binary,
  timeout: Schema.optional(Schema.Number),
  extensions: Schema.optional(Extensions),
};
const Assertion = Schema.Struct({
  ...Common,
  rpId: Schema.optional(Schema.String),
  userVerification: Schema.optional(Verification),
  allowCredentials: Schema.optional(Schema.Array(Descriptor)),
});
const Registration = Schema.Struct({
  ...Common,
  rp: Schema.Struct({ id: Schema.optional(Schema.String), name: Schema.String }),
  user: Schema.Struct({ id: Binary, name: Schema.String, displayName: Schema.String }),
  pubKeyCredParams: Schema.Array(
    Schema.Struct({ type: Schema.Literal("public-key"), alg: Schema.Number }),
  ),
  excludeCredentials: Schema.optional(Schema.Array(Descriptor)),
  attestation: Schema.optional(Schema.Literals(["none", "indirect", "direct", "enterprise"])),
  authenticatorSelection: Schema.optional(
    Schema.Struct({
      userVerification: Schema.optional(Verification),
      authenticatorAttachment: Schema.optional(Schema.Literals(["platform", "cross-platform"])),
    }),
  ),
});

const decodeRegistration = Schema.decodeUnknownSync(Registration);
const decodeAssertion = Schema.decodeUnknownSync(Assertion);

/** The origin is read from Electron's sender frame, never from page-supplied options. */
export function passkeyRpId(origin: string, requested?: string) {
  const url = new URL(origin);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new DOMException("Passkeys require a secure origin.", "SecurityError");
  }
  if (requested !== undefined && /[\s/:@?#%\\]/u.test(requested)) {
    throw new DOMException("The relying party must be a hostname.", "SecurityError");
  }
  const rpId =
    requested === undefined ? url.hostname : NodeURL.domainToASCII(requested).toLowerCase();
  if (!rpId) throw new DOMException("Invalid relying party hostname.", "SecurityError");
  if (rpId !== url.hostname && !url.hostname.endsWith(`.${rpId}`)) {
    throw new DOMException("The relying party does not match this page.", "SecurityError");
  }
  if (rpId !== "localhost" && !getDomain(rpId, { allowPrivateDomains: true })) {
    throw new DOMException(
      "The relying party must not be a public suffix or IP address.",
      "SecurityError",
    );
  }
  return rpId;
}

/** Decode just the fields the native provider implements; unsupported required features fail explicitly. */
export function normalizePasskeyRequest(operation: unknown, input: unknown, origin: string) {
  if (operation !== "get" && operation !== "create")
    throw new TypeError("Unknown passkey operation.");
  const create = operation === "create" ? decodeRegistration(input) : undefined;
  const get = operation === "get" ? decodeAssertion(input) : undefined;
  const options = create ?? get!;
  if (
    options.extensions?.appid ||
    options.extensions?.largeBlob?.support === "required" ||
    create?.authenticatorSelection?.authenticatorAttachment === "cross-platform" ||
    (create && !create.pubKeyCredParams.some(({ alg }) => alg === -7))
  ) {
    throw new DOMException(
      "This passkey request requires an unsupported feature.",
      "NotSupportedError",
    );
  }
  if (
    Buffer.from(options.challenge, "base64url").length === 0 ||
    (create &&
      (Buffer.from(create.user.id, "base64url").length === 0 ||
        Buffer.from(create.user.id, "base64url").length > 64))
  ) {
    throw new TypeError("Invalid passkey challenge or user ID.");
  }
  return {
    operation,
    origin,
    rpId: passkeyRpId(origin, create?.rp.id ?? get?.rpId),
    challenge: options.challenge,
    credentials: (create?.excludeCredentials ?? get?.allowCredentials ?? []).map(({ id }) => id),
    userVerification:
      create?.authenticatorSelection?.userVerification ?? get?.userVerification ?? "preferred",
    attestation: create?.attestation ?? "none",
    ...(create
      ? { userId: create.user.id, userName: create.user.name, displayName: create.user.displayName }
      : {}),
    timeout: Math.min(120_000, Math.max(15_000, options.timeout ?? 120_000)),
    credProps: create?.extensions?.credProps === true,
  };
}
