import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { stableStringify } from "./relaySigning.ts";

const DPOP_TYP = "dpop+jwt";
const DPOP_ALG = "ES256";
const DEFAULT_MAX_AGE_SECONDS = 300;

export const DpopPublicJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String.check(Schema.isNonEmpty()),
  y: Schema.String.check(Schema.isNonEmpty()),
});
export type DpopPublicJwk = typeof DpopPublicJwk.Type;
const isDpopPublicJwk = Schema.is(DpopPublicJwk);

interface DpopJwtHeader {
  readonly typ: string;
  readonly alg: string;
  readonly jwk: DpopPublicJwk;
}

interface DpopJwtPayload {
  readonly htm: string;
  readonly htu: string;
  readonly jti: string;
  readonly iat: number;
  readonly ath?: string;
}

export type DpopVerificationResult =
  | {
      readonly ok: true;
      readonly thumbprint: string;
      readonly jti: string;
      readonly iat: number;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

function base64UrlToBytes(value: string): Uint8Array {
  return Result.getOrThrow(Encoding.decodeBase64Url(value));
}

function decodeBase64UrlJson(value: string): unknown {
  return JSON.parse(Result.getOrThrow(Encoding.decodeBase64UrlString(value))) as unknown;
}

function isDpopJwtHeader(value: unknown): value is DpopJwtHeader {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.typ === DPOP_TYP &&
    record.alg === DPOP_ALG &&
    typeof record.jwk === "object" &&
    record.jwk !== null &&
    !("d" in record.jwk) &&
    isDpopPublicJwk(record.jwk)
  );
}

function isDpopJwtPayload(value: unknown): value is DpopJwtPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.htm === "string" &&
    record.htm.length > 0 &&
    typeof record.htu === "string" &&
    record.htu.length > 0 &&
    typeof record.jti === "string" &&
    record.jti.length > 0 &&
    typeof record.iat === "number" &&
    Number.isInteger(record.iat)
  );
}

function dpopThumbprintInput(jwk: DpopPublicJwk): string {
  return stableStringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
}

export function normalizeDpopHtu(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function computeDpopJwkThumbprint(jwk: DpopPublicJwk): string {
  return Encoding.encodeBase64Url(sha256(new TextEncoder().encode(dpopThumbprintInput(jwk))));
}

export function computeDpopAccessTokenHash(accessToken: string): string {
  return Encoding.encodeBase64Url(sha256(new TextEncoder().encode(accessToken)));
}

function publicKeyBytesFromJwk(jwk: DpopPublicJwk): Uint8Array {
  const x = base64UrlToBytes(jwk.x);
  const y = base64UrlToBytes(jwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("Invalid P-256 public key coordinate length.");
  }
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(x, 1);
  publicKey.set(y, 33);
  return publicKey;
}

export function verifyDpopProof(input: {
  readonly proof: string | null | undefined;
  readonly method: string;
  readonly url: string;
  readonly nowEpochSeconds: number;
  readonly expectedThumbprint?: string;
  readonly expectedAccessToken?: string;
  readonly maxAgeSeconds?: number;
}): DpopVerificationResult {
  if (!input.proof?.trim()) {
    return { ok: false, reason: "Missing DPoP proof." };
  }

  const parts = input.proof.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, reason: "Invalid DPoP compact JWT." };
  }

  try {
    const header = decodeBase64UrlJson(parts[0]);
    const payload = decodeBase64UrlJson(parts[1]);
    if (!isDpopJwtHeader(header)) {
      return { ok: false, reason: "Invalid DPoP JWT header." };
    }
    if (!isDpopJwtPayload(payload)) {
      return { ok: false, reason: "Invalid DPoP JWT payload." };
    }

    const thumbprint = computeDpopJwkThumbprint(header.jwk);
    if (input.expectedThumbprint && thumbprint !== input.expectedThumbprint) {
      return { ok: false, reason: "DPoP key thumbprint mismatch." };
    }
    if (payload.htm.toUpperCase() !== input.method.toUpperCase()) {
      return { ok: false, reason: "DPoP method mismatch." };
    }
    const normalizedHtu = normalizeDpopHtu(input.url);
    if (normalizedHtu === null || payload.htu !== normalizedHtu) {
      return { ok: false, reason: "DPoP URL mismatch." };
    }
    if (input.expectedAccessToken) {
      const expectedAth = computeDpopAccessTokenHash(input.expectedAccessToken);
      if (payload.ath !== expectedAth) {
        return { ok: false, reason: "DPoP access token hash mismatch." };
      }
    }

    const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
    if (
      payload.iat > input.nowEpochSeconds + 5 ||
      input.nowEpochSeconds - payload.iat > maxAgeSeconds
    ) {
      return { ok: false, reason: "DPoP proof is outside the allowed time window." };
    }

    const signature = base64UrlToBytes(parts[2]);
    const signatureInputHash = sha256(new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    const verified = p256.verify(signature, signatureInputHash, publicKeyBytesFromJwk(header.jwk), {
      prehash: false,
      format: "compact",
    });
    return verified
      ? {
          ok: true,
          thumbprint,
          jti: payload.jti,
          iat: payload.iat,
        }
      : { ok: false, reason: "Invalid DPoP signature." };
  } catch {
    return { ok: false, reason: "Invalid DPoP proof." };
  }
}
