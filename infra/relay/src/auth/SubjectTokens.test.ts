import { verifyToken } from "@clerk/backend";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Jwk from "effect/jose/Jwk";
import * as Jwks from "effect/jose/Jwks";
import * as Jwt from "effect/jose/Jwt";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import type * as RelayConfiguration from "../Config.ts";
import {
  makeOidcKeySet,
  makeOidcVerifier,
  oidcAccountId,
  verifySubjectToken,
} from "./SubjectTokens.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

const ISSUER = "https://sso.example.com/realms/t3";
const AUDIENCE = "t3-code-relay";
const CLERK_AUDIENCE = "t3-code-relay-clerk";

const crypto = Signature.layerWebCrypto.pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));
const Claims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  iat: Schema.Number,
  exp: Schema.Number,
});

const signToken = Effect.fn("test.signToken")(function* (options: {
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly expiresInSeconds?: number;
  readonly privateKey: Jwk.PrivateKey;
}) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const token = yield* Jwt.sign(
    Claims,
    {
      iss: options.issuer ?? ISSUER,
      aud: options.audience ?? AUDIENCE,
      sub: options.subject ?? "user-1",
      iat: now,
      exp: now + (options.expiresInSeconds ?? 300),
    },
    options.privateKey,
    { kid: "k1" },
  );
  return Redacted.value(token);
});

const settingsWith = (verify: RelayConfiguration.OidcSettings["verify"]) =>
  ({
    relayIssuer: "https://relay.example.com",
    clerkSecretKey: Redacted.make("clerk-secret-key"),
    clerkPublishableKey: "pk_test",
    clerkJwtAudience: CLERK_AUDIENCE,
    oidc: { issuer: ISSUER, clientId: "t3-code", verify },
  }) as unknown as RelayConfiguration.RelayConfiguration["Service"];

const requestUrl = (input: RequestInfo | URL) =>
  input instanceof Request ? input.url : String(input);

// FetchHttpClient caches the global fetch it first sees, so tests inject theirs instead of spying.
const fakeFetch = (discovery: unknown, keys: ReadonlyArray<unknown> = []) =>
  vi.fn(async (input: RequestInfo | URL) =>
    requestUrl(input).endsWith("/.well-known/openid-configuration")
      ? Response.json(discovery)
      : Response.json({ keys }),
  );

const discoverWith = (fetches: ReturnType<typeof fakeFetch>) =>
  makeOidcKeySet(ISSUER).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetches as unknown as typeof fetch),
  );

const fixture = Effect.gen(function* () {
  const keys = yield* Jwk.generateKeyPair({ algorithm: "ES256", kid: "k1" });
  const signingKey = yield* Jwk.importPrivate(keys.privateKey, "ES256");
  const jwks = yield* Jwks.makeLocal({ keys: [keys.publicKey] });
  const verify = yield* makeOidcVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    keySet: Effect.succeed(jwks),
  });
  return {
    publicKey: keys.publicKey,
    settings: settingsWith(verify),
    sign: (options: Omit<Parameters<typeof signToken>[0], "privateKey"> = {}) =>
      signToken({ privateKey: signingKey, ...options }),
  };
});

it.layer(crypto)("SubjectTokens", (it) => {
  it.effect("accepts a token from the configured issuer under a namespaced account id", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const token = yield* f.sign();

      expect(yield* verifySubjectToken(f.settings, token, { acceptClerkOAuth: false })).toEqual({
        sub: oidcAccountId(ISSUER, "user-1"),
        mode: "oidc_bearer",
      });
      expect(verifyToken).not.toHaveBeenCalled();
    }),
  );

  it.effect("rejects configured-issuer tokens for another audience", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const token = yield* f.sign({ audience: "someone-else" });

      const exit = yield* Effect.exit(
        verifySubjectToken(f.settings, token, { acceptClerkOAuth: false }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("rejects expired configured-issuer tokens", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const token = yield* f.sign({ expiresInSeconds: -60 });

      const exit = yield* Effect.exit(
        verifySubjectToken(f.settings, token, { acceptClerkOAuth: false }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("rejects tokens signed by a key the issuer does not publish", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const attacker = yield* Jwk.generateKeyPair({ algorithm: "ES256", kid: "k1" });
      const token = yield* signToken({
        privateKey: yield* Jwk.importPrivate(attacker.privateKey, "ES256"),
      });

      const exit = yield* Effect.exit(
        verifySubjectToken(f.settings, token, { acceptClerkOAuth: false }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("sends other issuers through Clerk unchanged", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "user_clerk",
        aud: CLERK_AUDIENCE,
      } as never);
      const token = yield* f.sign({ issuer: "https://clerk.example.com" });

      expect(yield* verifySubjectToken(f.settings, token, { acceptClerkOAuth: false })).toEqual({
        sub: "user_clerk",
        mode: "clerk_session_bearer",
      });
      expect(verifyToken).toHaveBeenCalledWith(token, {
        secretKey: "clerk-secret-key",
        audience: CLERK_AUDIENCE,
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.mocked(verifyToken).mockReset();
        }),
      ),
    ),
  );

  it.effect("keeps the configured issuer string verbatim behind a path-prefixed proxy", () =>
    Effect.gen(function* () {
      const fetches = fakeFetch({
        issuer: ISSUER,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
      });
      const [keySet] = yield* discoverWith(fetches);
      const resolved = yield* keySet;

      expect(resolved).toBe(yield* keySet);
      expect(fetches.mock.calls.map(([input]) => requestUrl(input))).toEqual([
        `${ISSUER}/.well-known/openid-configuration`,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("verifies a token against the key set the issuer's discovery points to", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fetches = fakeFetch({ issuer: ISSUER, jwks_uri: `${ISSUER}/certs` }, [f.publicKey]);
      const [keySet] = yield* discoverWith(fetches);
      const verifyRemote = yield* makeOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet });

      expect(yield* verifyRemote(yield* f.sign())).toEqual({
        sub: oidcAccountId(ISSUER, "user-1"),
        mode: "oidc_bearer",
      });
      expect(fetches.mock.calls.map(([input]) => requestUrl(input))).toEqual([
        `${ISSUER}/.well-known/openid-configuration`,
        `${ISSUER}/certs`,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses discovery documents whose issuer differs by a trailing slash", () =>
    Effect.gen(function* () {
      const [keySet] = yield* discoverWith(
        fakeFetch({ issuer: `${ISSUER}/`, jwks_uri: `${ISSUER}/certs` }),
      );

      const error = yield* Effect.flip(keySet);
      expect(error.cause).toBe("oidc_issuer_mismatch");
    }).pipe(Effect.scoped),
  );
});
