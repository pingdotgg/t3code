import * as crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { HttpEffect } from "../Http.ts";
import { RPC_PATH_PREFIX, serveRpc } from "../Rpc.ts";

/** Machine env var holding the Service's caller token. */
export const RPC_TOKEN_ENV = "ALCHEMY_FLY_RPC_TOKEN";
/** Machine env var holding the organization callers must belong to. */
export const RPC_ORG_ENV = "ALCHEMY_FLY_ORG";
/**
 * Machine env var holding the published port Alchemy added for bindings.
 * Requests on it must come from Fly's private network.
 */
export const BINDING_PORT_ENV = "ALCHEMY_FLY_BINDING_PORT";
/** Request header carrying the caller token. */
export const RPC_TOKEN_HEADER = "x-alchemy-rpc-token";
/** Published port Alchemy adds when a Service has no plain-HTTP port. */
export const DEFAULT_BINDING_PORT = 7780;

/** Fly's signed origin header on Flycast requests, and its public key. */
const FLY_SRC_HEADER = "fly-src";
const FLY_SRC_SIGNATURE_HEADER = "fly-src-signature";
const FLY_SRC_PUBLIC_KEY = "/.fly/fly-src.pub";
/** DER prefix that wraps a raw 32-byte ed25519 key as SubjectPublicKeyInfo. */
const ED25519_SPKI_PREFIX = "302a300506032b6570032100";
/** Oldest accepted `Fly-Src` timestamp, in seconds. */
const MAX_FLY_SRC_AGE_SECONDS = 300;

const header = (
  headers: Record<string, string | undefined>,
  name: string,
): string => headers[name] ?? "";

const tokensEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
};

let publicKey: crypto.KeyObject | undefined;

/** Load Fly's `Fly-Src` verification key once per instance. */
const loadPublicKey = Effect.gen(function* () {
  if (publicKey !== undefined) return publicKey;
  const fs = yield* FileSystem.FileSystem;
  const hex = yield* fs.readFileString(FLY_SRC_PUBLIC_KEY).pipe(
    Effect.map((text) => text.trim()),
    Effect.orElseSucceed(() => ""),
  );
  if (hex.length === 0) return undefined;
  const key = yield* Effect.try(() =>
    crypto.createPublicKey({
      key: Buffer.from(`${ED25519_SPKI_PREFIX}${hex}`, "hex"),
      format: "der",
      type: "spki",
    }),
  ).pipe(Effect.orElseSucceed(() => undefined));
  publicKey = key;
  return key;
});

/**
 * Whether the request carries a valid `Fly-Src` signature from Fly's proxy
 * for a caller in `org`. Fly adds the header only to requests that arrive
 * over its private network, so a public request can never pass.
 */
export const verifyFlySrc = (
  headers: Record<string, string | undefined>,
  org: string,
) =>
  Effect.gen(function* () {
    const source = header(headers, FLY_SRC_HEADER);
    const signature = header(headers, FLY_SRC_SIGNATURE_HEADER);
    if (source.length === 0 || signature.length === 0 || org.length === 0)
      return false;
    const key = yield* loadPublicKey;
    if (key === undefined) return false;
    const valid = yield* Effect.try(() =>
      crypto.verify(
        null,
        Buffer.from(source),
        key,
        Buffer.from(signature, "base64"),
      ),
    ).pipe(Effect.orElseSucceed(() => false));
    if (!valid) return false;
    const fields = Object.fromEntries(
      source.split(";").map((pair) => {
        const at = pair.indexOf("=");
        return [pair.slice(0, at), pair.slice(at + 1)];
      }),
    );
    const now = yield* Effect.sync(() => Date.now() / 1000);
    const age = now - Number(fields.ts);
    return fields.org === org && age >= -60 && age <= MAX_FLY_SRC_AGE_SECONDS;
  });

const unauthorized = HttpServerResponse.text("Unauthorized", { status: 401 });

/**
 * Serve a Service's RPC methods on `/__rpc__/*` and everything else with
 * `fallback`. RPC calls must carry the Service's caller token and a valid
 * `Fly-Src` signature from the Service's organization. Every request on the
 * port Alchemy added for bindings must carry the `Fly-Src` signature, so
 * that port never answers the public internet.
 */
export const serveFlyRpc = <Req = never>(
  shape: Record<string, unknown>,
  fallback: HttpEffect<Req>,
): HttpEffect<Req | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const headers = request.headers as Record<string, string | undefined>;
    const isRpc = request.url.includes(RPC_PATH_PREFIX);
    const env = yield* Effect.sync(() => ({
      bindingPort: process.env[BINDING_PORT_ENV] ?? "",
      org: process.env[RPC_ORG_ENV] ?? "",
      token: process.env[RPC_TOKEN_ENV] ?? "",
    }));
    const bindingPort = env.bindingPort;
    const onBindingPort =
      bindingPort.length > 0 &&
      header(headers, "fly-forwarded-port") === bindingPort;
    if (!isRpc && !onBindingPort) return yield* fallback;
    if (!(yield* verifyFlySrc(headers, env.org))) return unauthorized;
    if (isRpc) {
      const expected = env.token;
      const provided = header(headers, RPC_TOKEN_HEADER);
      if (
        expected.length === 0 ||
        provided.length === 0 ||
        !tokensEqual(provided, expected)
      ) {
        return unauthorized;
      }
    }
    return yield* serveRpc(shape, fallback);
  });

/** Methods on an impl shape that are served as RPC. */
export const rpcMethodsOf = (shape: Record<string, unknown> | undefined) =>
  Object.fromEntries(
    Object.entries(shape ?? {}).filter(
      ([key, value]) =>
        key !== "fetch" && key !== "run" && typeof value === "function",
    ),
  );
