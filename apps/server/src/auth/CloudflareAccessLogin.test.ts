// @effect-diagnostics nodeBuiltinImport:off - Node generates the RSA keys a Cloudflare team would sign with.
import * as NodeCrypto from "node:crypto";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as CloudflareAccessLogin from "./CloudflareAccessLogin.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const TEAM = "team.cloudflareaccess.com";
const AUD = "0123456789abcdef-aud";
const KID = "cf-signing-key";
const CONFIGURED = {
  T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN: TEAM,
  T3CODE_CLOUDFLARE_ACCESS_AUD: AUD,
  T3CODE_CLOUDFLARE_ACCESS_EMAILS: "Owner@Example.com, second@example.com",
};

const teamKey = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
// Same kid, different key: a forged token resolves the real key and must fail the signature.
const impostorKey = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

// The shape Cloudflare serves at /cdn-cgi/access/certs, extra members included.
const certsBody = JSON.stringify({
  keys: [{ ...teamKey.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }],
  public_cert: { kid: KID, cert: "-----BEGIN CERTIFICATE-----" },
  public_certs: [{ kid: KID, cert: "-----BEGIN CERTIFICATE-----" }],
});

const signAssertion = (
  claims: Record<string, unknown>,
  privateKey: NodeCrypto.KeyObject = teamKey.privateKey,
) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", kid: KID, typ: "JWT" })}.${encode(claims)}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
};

const accessClaims = Effect.map(Clock.currentTimeMillis, (millis) => {
  const now = Math.floor(millis / 1000);
  return {
    iss: `https://${TEAM}`,
    aud: [AUD],
    email: "OWNER@example.com",
    sub: "7335d417-61da-459d-899c-0a01c76a2f94",
    type: "app",
    iat: now,
    nbf: now,
    exp: now + 300,
  };
});

type CertsEndpoint = "ok" | "error-status" | "unreachable";

const layerCerts = (endpoint: CertsEndpoint, requests: Array<string>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        requests.push(request.url);
        if (endpoint === "unreachable") {
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            }),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            endpoint === "ok"
              ? new Response(certsBody, { headers: { "content-type": "application/json" } })
              : new Response("upstream error", { status: 500 }),
          ),
        );
      }),
    ),
  );

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cloudflare-access-test-" })),
);

const layerLogin = (input: {
  readonly env: Record<string, string>;
  readonly certs?: CertsEndpoint;
  readonly certRequests?: Array<string>;
}) =>
  CloudflareAccessLogin.layer.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env }))),
    Layer.provide(layerCerts(input.certs ?? "ok", input.certRequests ?? [])),
    Layer.provideMerge(layerEnvironmentAuth),
  );

const loginTag = (assertion: string | undefined) =>
  CloudflareAccessLogin.CloudflareAccessLogin.pipe(
    Effect.flatMap((service) => service.login(assertion)),
    Effect.flip,
    Effect.map((error) => error._tag),
  );

const activeLinkCount = EnvironmentAuth.EnvironmentAuth.pipe(
  Effect.flatMap((auth) => auth.listPairingLinks()),
  Effect.map((links) => links.length),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))(
  "CloudflareAccessLogin",
  (it) => {
    it.effect("mints the same one-time pairing as `t3 pair` for an allowed identity", () =>
      Effect.gen(function* () {
        const certRequests: Array<string> = [];
        yield* Effect.gen(function* () {
          const service = yield* CloudflareAccessLogin.CloudflareAccessLogin;
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          const issued = yield* service.login(signAssertion(yield* accessClaims));

          const [link] = yield* auth.listPairingLinks();
          assert.strictEqual(link?.subject, "one-time-token");
          assert.strictEqual(link?.label, "Google: owner@example.com");
          assert.deepStrictEqual(link?.permissions, [...AuthStandardClientScopes]);
          assert.strictEqual(
            DateTime.toEpochMillis(issued.expiresAt) - DateTime.toEpochMillis(link!.createdAt),
            2 * 60 * 1000,
          );

          // The browser redeems it through the normal /pair exchange, once.
          const session = yield* auth.createBrowserSession(issued.credential, {
            deviceType: "desktop",
          });
          assert.isTrue(session.response.authenticated);
          assert.strictEqual(yield* activeLinkCount, 0);
        }).pipe(Effect.provide(layerLogin({ env: CONFIGURED, certRequests })));
        assert.deepStrictEqual(certRequests, [`https://${TEAM}/cdn-cgi/access/certs`]);
      }),
    );

    it.effect("refuses assertions that fail verification and mints nothing", () =>
      Effect.gen(function* () {
        const claims = yield* accessClaims;
        const { email: _email, ...serviceTokenClaims } = claims;
        const refused = {
          forgedSignature: [
            signAssertion(claims, impostorKey.privateKey),
            "SignatureVerificationFailed",
          ],
          otherAudience: [
            signAssertion({ ...claims, aud: "another-app" }),
            "ClaimValidationFailed:aud:mismatch",
          ],
          audienceArrayWithoutOurs: [
            signAssertion({ ...claims, aud: ["another-app"] }),
            "ClaimValidationFailed:aud:mismatch",
          ],
          otherIssuer: [
            signAssertion({ ...claims, iss: "https://other.cloudflareaccess.com" }),
            "ClaimValidationFailed:iss:mismatch",
          ],
          expired: [
            signAssertion({ ...claims, exp: claims.iat - 60 }),
            "ClaimValidationFailed:exp:expired",
          ],
          withoutExpiry: [
            signAssertion({ ...claims, exp: undefined }),
            "ClaimValidationFailed:exp:missing",
          ],
          serviceToken: [
            signAssertion({ ...serviceTokenClaims, common_name: "client.access" }),
            "claims",
          ],
          emptyEmail: [signAssertion({ ...claims, email: "" }), "claims"],
          notAJwt: ["not-a-jwt", "InvalidToken"],
          oversized: ["a".repeat(17 * 1024), "too_long"],
        } as const;
        for (const [name, [assertion, reason]] of Object.entries(refused)) {
          const error = yield* CloudflareAccessLogin.CloudflareAccessLogin.pipe(
            Effect.flatMap((service) => service.login(assertion)),
            Effect.flip,
          );
          assert.strictEqual(error._tag, "CloudflareAccessAssertionInvalidError", name);
          assert.strictEqual("reason" in error ? error.reason : undefined, reason, name);
        }
        assert.strictEqual(
          yield* loginTag(signAssertion({ ...claims, email: "stranger@example.com" })),
          "CloudflareAccessEmailNotAllowedError",
        );
        assert.strictEqual(yield* loginTag(undefined), "CloudflareAccessAssertionMissingError");
        assert.strictEqual(yield* loginTag("  "), "CloudflareAccessAssertionMissingError");
        assert.strictEqual(yield* activeLinkCount, 0);
      }).pipe(Effect.provide(layerLogin({ env: CONFIGURED }))),
    );

    it.effect("refuses when the team's signing keys cannot be fetched", () =>
      Effect.gen(function* () {
        for (const certs of ["error-status", "unreachable"] as const) {
          const tag = yield* accessClaims.pipe(
            Effect.flatMap((claims) => loginTag(signAssertion(claims))),
            Effect.provide(layerLogin({ env: CONFIGURED, certs })),
          );
          assert.strictEqual(tag, "CloudflareAccessKeysUnavailableError", certs);
        }
      }),
    );

    it.effect("stays off unless all three variables are set and valid", () =>
      Effect.gen(function* () {
        const configurations = {
          none: {},
          teamAndAudienceOnly: {
            T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN: TEAM,
            T3CODE_CLOUDFLARE_ACCESS_AUD: AUD,
          },
          emailsOnly: { T3CODE_CLOUDFLARE_ACCESS_EMAILS: "owner@example.com" },
          teamDomainWithPath: {
            ...CONFIGURED,
            T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN: `${TEAM}/cdn-cgi`,
          },
          blankEmails: { ...CONFIGURED, T3CODE_CLOUDFLARE_ACCESS_EMAILS: " , " },
        };
        for (const [name, env] of Object.entries(configurations)) {
          const certRequests: Array<string> = [];
          const tag = yield* accessClaims.pipe(
            Effect.flatMap((claims) => loginTag(signAssertion(claims))),
            Effect.provide(layerLogin({ env, certRequests })),
          );
          assert.strictEqual(tag, "CloudflareAccessLoginDisabledError", name);
          assert.deepStrictEqual(certRequests, [], name);
        }
      }),
    );
  },
);
