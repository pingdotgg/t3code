/**
 * Keys, PKCS#10 certificate requests and X.509 parsing for the ACME flow.
 * WebCrypto plus the tiny DER codec in `Der.ts` — no native code, so the
 * same code runs at deploy time and inside a Worker or Fly Service.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Jose } from "@distilled.cloud/acme";
import * as Der from "./Der.ts";
import { PkiError } from "./Errors.ts";

export type KeyAlgorithm = "ES256" | "RS256";

const OID = {
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  extensionRequest: "1.2.840.113549.1.9.14",
  subjectAltName: "2.5.29.17",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  sha256WithRsa: "1.2.840.113549.1.1.11",
} as const;

const keyGenParams = (alg: KeyAlgorithm) =>
  alg === "RS256"
    ? {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      }
    : { name: "ECDSA", namedCurve: "P-256" };

const importParams = (alg: KeyAlgorithm) =>
  alg === "RS256"
    ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
    : { name: "ECDSA", namedCurve: "P-256" };

const signParams = (alg: KeyAlgorithm) =>
  alg === "RS256"
    ? { name: "RSASSA-PKCS1-v1_5" }
    : { name: "ECDSA", hash: "SHA-256" };

const toPem = (label: string, der: Uint8Array): string => {
  const b64 = btoa(String.fromCharCode(...der));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

/** The DER bytes of the first (or `index`-th) PEM block in `pem`. */
export const fromPem = (pem: string, index = 0): Uint8Array => {
  const blocks = pem.match(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g);
  const block = blocks?.[index];
  if (block === undefined) {
    throw new Error(`PEM block ${index} not found`);
  }
  const body = block
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

/** Every PEM block in a chain, leaf first. */
export const splitPemChain = (pem: string): string[] =>
  pem.match(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g) ?? [];

const tryPromise = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new PkiError({ message, cause }),
  });

export interface GeneratedKey {
  readonly algorithm: KeyAlgorithm;
  /** PKCS#8 PEM. */
  readonly privateKeyPem: Redacted.Redacted<string>;
  readonly privateKey: CryptoKey;
  /** SubjectPublicKeyInfo DER. */
  readonly spki: Uint8Array;
}

/** Generate a certificate key pair (ES256 P-256 by default). */
export const generateKey = (
  algorithm: KeyAlgorithm = "ES256",
): Effect.Effect<GeneratedKey, PkiError> =>
  tryPromise("Generating the certificate key failed.", async () => {
    const pair = await crypto.subtle.generateKey(
      keyGenParams(algorithm),
      true,
      ["sign", "verify"],
    );
    const pkcs8 = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    );
    const spki = new Uint8Array(
      await crypto.subtle.exportKey("spki", pair.publicKey),
    );
    return {
      algorithm,
      privateKeyPem: Redacted.make(toPem("PRIVATE KEY", pkcs8)),
      privateKey: pair.privateKey,
      spki,
    };
  });

const algorithmOfPkcs8 = (der: Uint8Array): KeyAlgorithm => {
  // PrivateKeyInfo ::= SEQUENCE { version, AlgorithmIdentifier, ... }
  const root = Der.read(der, 0);
  const [, algorithm] = Der.children(root);
  const [algOid] = Der.children(algorithm!);
  return Der.decodeOid(algOid!) === "1.2.840.113549.1.1.1" ? "RS256" : "ES256";
};

/** Import a PKCS#8 PEM private key (ES256 or RS256, detected from the DER). */
export const importPrivateKey = (
  pem: Redacted.Redacted<string> | string,
): Effect.Effect<
  { readonly key: CryptoKey; readonly algorithm: KeyAlgorithm },
  PkiError
> =>
  tryPromise("Importing the certificate key failed.", async () => {
    const text = Redacted.isRedacted(pem) ? Redacted.value(pem) : pem;
    const der = fromPem(text);
    const algorithm = algorithmOfPkcs8(der);
    const key = await crypto.subtle.importKey(
      "pkcs8",
      der as Uint8Array<ArrayBuffer>,
      importParams(algorithm),
      true,
      ["sign"],
    );
    return { key, algorithm };
  });

/** The private JWK of a PKCS#8 PEM key (for revocation signed by the certificate key). */
export const privateKeyToJwk = (
  pem: Redacted.Redacted<string> | string,
): Effect.Effect<Redacted.Redacted<string>, PkiError> =>
  importPrivateKey(pem).pipe(
    Effect.flatMap(({ key }) =>
      tryPromise("Exporting the certificate key as a JWK failed.", async () =>
        Redacted.make(
          JSON.stringify(await crypto.subtle.exportKey("jwk", key)),
        ),
      ),
    ),
  );

/** Raw `r || s` ECDSA signature → DER `SEQUENCE { r INTEGER, s INTEGER }`. */
const ecdsaToDer = (raw: Uint8Array): Uint8Array => {
  const half = raw.length / 2;
  return Der.sequence(
    Der.integer(raw.subarray(0, half)),
    Der.integer(raw.subarray(half)),
  );
};

/**
 * A PKCS#10 certificate request for `identifiers` signed by `key`: the
 * first identifier is the subject CN, all of them are `subjectAltName`
 * dNSName entries. Returned as DER.
 */
export const createCsr = (options: {
  readonly key: GeneratedKey;
  readonly identifiers: ReadonlyArray<string>;
}): Effect.Effect<Uint8Array, PkiError> =>
  tryPromise("Encoding the certificate request failed.", async () => {
    const { key, identifiers } = options;
    if (identifiers.length === 0) {
      throw new Error("a certificate needs at least one identifier");
    }
    const subject = Der.sequence(
      Der.set(
        Der.sequence(Der.oid(OID.commonName), Der.utf8String(identifiers[0]!)),
      ),
    );
    const sanExtension = Der.sequence(
      Der.oid(OID.subjectAltName),
      Der.octetString(
        Der.sequence(
          ...identifiers.map((name) =>
            Der.contextPrimitive(2, new TextEncoder().encode(name)),
          ),
        ),
      ),
    );
    const attributes = Der.contextTag(
      0,
      Der.sequence(
        Der.oid(OID.extensionRequest),
        Der.set(Der.sequence(sanExtension)),
      ),
    );
    const info = Der.sequence(Der.integer(0), subject, key.spki, attributes);
    const rawSignature = new Uint8Array(
      await crypto.subtle.sign(
        signParams(key.algorithm),
        key.privateKey,
        info as Uint8Array<ArrayBuffer>,
      ),
    );
    const signature =
      key.algorithm === "ES256" ? ecdsaToDer(rawSignature) : rawSignature;
    const algorithm =
      key.algorithm === "ES256"
        ? Der.sequence(Der.oid(OID.ecdsaWithSha256))
        : Der.sequence(Der.oid(OID.sha256WithRsa), Der.nullValue());
    return Der.sequence(info, algorithm, Der.bitString(signature));
  });

/** base64url of a DER CSR, as ACME's `finalize` expects. */
export const csrToBase64Url = (der: Uint8Array): string => Jose.base64url(der);

// =============================================================================
// X.509 parsing
// =============================================================================

export interface ParsedCertificate {
  /** Serial number as lowercase hex. */
  readonly serial: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** Issuer distinguished name, `CN` first (`CN=R11, O=Let's Encrypt`). */
  readonly issuer: string;
  /** Subject distinguished name in the same form. */
  readonly subject: string;
  /** `subjectAltName` dNSName entries. */
  readonly dnsNames: ReadonlyArray<string>;
}

const decodeName = (name: Der.Node): string => {
  const parts: string[] = [];
  for (const rdn of Der.children(name)) {
    for (const attribute of Der.children(rdn)) {
      const [typeNode, valueNode] = Der.children(attribute);
      const type = Der.decodeOid(typeNode!);
      const value = new TextDecoder().decode(Der.content(valueNode!));
      const label =
        type === OID.commonName
          ? "CN"
          : type === OID.organization
            ? "O"
            : type === "2.5.4.6"
              ? "C"
              : type;
      parts.push(`${label}=${value}`);
    }
  }
  // CN first for readability; the rest keep their order.
  parts.sort((a, b) =>
    a.startsWith("CN=") ? -1 : b.startsWith("CN=") ? 1 : 0,
  );
  return parts.join(", ");
};

/** Parse the first certificate of a PEM (or a DER buffer). */
export const parseCertificate = (
  input: string | Uint8Array,
): Effect.Effect<ParsedCertificate, PkiError> =>
  Effect.try({
    try: () => {
      const der = typeof input === "string" ? fromPem(input) : input;
      const certificate = Der.read(der, 0);
      const [tbs] = Der.children(certificate);
      const fields = Der.children(tbs!);
      let index = 0;
      if (fields[0]!.tag === 0xa0) index++; // [0] EXPLICIT version
      const serial = Der.toHex(Der.content(fields[index++]!));
      index++; // signature AlgorithmIdentifier
      const issuer = decodeName(fields[index++]!);
      const [notBeforeNode, notAfterNode] = Der.children(fields[index++]!);
      const subject = decodeName(fields[index++]!);
      index++; // subjectPublicKeyInfo
      const dnsNames: string[] = [];
      for (const field of fields.slice(index)) {
        if (field.tag !== 0xa3) continue; // [3] EXPLICIT extensions
        const [extensions] = Der.children(field);
        for (const extension of Der.children(extensions!)) {
          const members = Der.children(extension);
          if (Der.decodeOid(members[0]!) !== OID.subjectAltName) continue;
          const valueNode = members[members.length - 1]!; // OCTET STRING (critical may precede)
          const generalNames = Der.read(Der.content(valueNode), 0);
          for (const generalName of Der.children(generalNames)) {
            if (generalName.tag === 0x82) {
              dnsNames.push(new TextDecoder().decode(Der.content(generalName)));
            }
          }
        }
      }
      return {
        serial: serial.replace(/^00/, "") || "0",
        notBefore: Der.decodeTime(notBeforeNode!),
        notAfter: Der.decodeTime(notAfterNode!),
        issuer,
        subject,
        dnsNames,
      };
    },
    catch: (cause) =>
      new PkiError({ message: "Parsing the certificate failed.", cause }),
  });
