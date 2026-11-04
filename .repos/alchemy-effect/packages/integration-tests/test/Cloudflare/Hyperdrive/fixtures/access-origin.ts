import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * A Hyperdrive origin behind Cloudflare Access: a local Postgres reached
 * through a Cloudflare Tunnel, published on {@link ACCESS_ORIGIN_HOST} and
 * guarded by a self-hosted Access application that admits one service token.
 * `cloudflared` runs on the test machine with the tunnel's token (see the
 * Access test in `Hyperdrive.test.ts`).
 */
export const ACCESS_ORIGIN_ZONE = "alchemy-test-2.us";
export const ACCESS_ORIGIN_HOST = `hyperdrive-access-${(
  process.env.ALCHEMY_TEST_STAGE ??
  process.env.PULL_REQUEST ??
  process.env.USER ??
  "local"
)
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, "-")}.${ACCESS_ORIGIN_ZONE}`;
export const ACCESS_ORIGIN_PORT = 15432;
export const ACCESS_ORIGIN_PASSWORD = "alchemy-access-origin";

/** The service token Access admits; shared by logical id with the route. */
export const AccessOriginToken = Cloudflare.Access.ServiceToken("HyperdriveAccessToken", {});

/**
 * Tunnel, proxied CNAME and Access application publishing the local
 * Postgres on {@link ACCESS_ORIGIN_HOST}.
 */
export const AccessOriginRoute = (zoneId: string) =>
  Effect.gen(function* () {
    const tunnel = yield* Cloudflare.Tunnel.Tunnel("HyperdriveAccessTunnel", {
      ingress: [
        { hostname: ACCESS_ORIGIN_HOST, service: `tcp://localhost:${ACCESS_ORIGIN_PORT}` },
        { service: "http_status:404" },
      ],
    });
    yield* Cloudflare.DNS.Record("HyperdriveAccessCname", {
      zoneId,
      name: ACCESS_ORIGIN_HOST,
      type: "CNAME",
      content: tunnel.tunnelId.pipe(Output.map((id) => `${id}.cfargotunnel.com`)),
      proxied: true,
    });
    const token = yield* AccessOriginToken;
    yield* Cloudflare.Access.Application("HyperdriveAccessApp", {
      type: "self_hosted",
      domain: ACCESS_ORIGIN_HOST,
      policies: [{ decision: "non_identity", include: [{ serviceToken: token.serviceTokenId }] }],
    });
    return { tunnel, token };
  });

/**
 * The Hyperdrive Connection for the Access-protected origin. It has no `dev`
 * override — the shape that used to fail `alchemy deploy` (#1836).
 */
export const AccessOriginConnection = Effect.gen(function* () {
  const token = yield* AccessOriginToken;
  return yield* Cloudflare.Hyperdrive.Connection("HyperdriveAccessConnection", {
    origin: {
      scheme: "postgres",
      host: ACCESS_ORIGIN_HOST,
      database: "postgres",
      user: "postgres",
      password: Redacted.make(ACCESS_ORIGIN_PASSWORD),
      accessClientId: token.clientId.pipe(Output.map(Redacted.make)),
      accessClientSecret: token.clientSecret.pipe(Output.map((secret) => secret!)),
    },
  });
});
