import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Ride out 403 blips (`Forbidden`) while the harness-minted token
// propagates across Cloudflare's edge.
const getIdp = (accountId: string, identityProviderId: string) =>
  zeroTrust
    .getIdentityProviderForAccount({ accountId, identityProviderId })
    .pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: Schedule.exponential("500 millis"),
        times: 8,
      }),
    );

// A deleted IdP surfaces as `AccessIdentityProviderNotFound` (Cloudflare
// code 12135, `access.api.error.not_found`).
const expectGone = (accountId: string, identityProviderId: string) =>
  getIdp(accountId, identityProviderId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "IdpNotDeleted" } as const)),
    Effect.catchTag("AccessIdentityProviderNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "IdpNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Generic OIDC config with documentation-only placeholder endpoints —
// Cloudflare validates the shape, not the reachability.
const oidcConfig = {
  clientId: "alchemy-test-client",
  clientSecret: "alchemy-test-secret",
  authUrl: "https://idp.alchemy-test.example/authorize",
  tokenUrl: "https://idp.alchemy-test.example/token",
  certsUrl: "https://idp.alchemy-test.example/keys",
  scopes: ["openid", "email", "profile"],
};

test.provider("create, verify, and destroy an OIDC IdP", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const idp = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("BasicOidc", {
        name: "alchemy-zt-idp-basic",
        type: "oidc",
        config: oidcConfig,
      }),
    );

    expect(idp.identityProviderId).toBeTruthy();
    expect(idp.accountId).toEqual(accountId);
    expect(idp.name).toEqual("alchemy-zt-idp-basic");
    expect(idp.type).toEqual("oidc");

    const live = yield* getIdp(accountId, idp.identityProviderId);
    expect(live.name).toEqual("alchemy-zt-idp-basic");
    expect(live.type).toEqual("oidc");
    // Cloudflare masks the client secret on read.
    expect(
      (live.config as { clientSecret?: string | null }).clientSecret ?? null,
    ).toBeNull();

    yield* stack.destroy();
    yield* expectGone(accountId, idp.identityProviderId);
  }).pipe(logLevel),
);

test.provider("update name and config in place (same id)", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("UpdateOidc", {
        name: "alchemy-zt-idp-update",
        type: "oidc",
        config: oidcConfig,
      }),
    );

    // Note: assert the config change through `claims` — distilled decodes
    // the GET response through a discriminated union whose matched variant
    // does not carry the oidc-only fields (authUrl/tokenUrl/…), so those
    // are stripped from the decoded value even though Cloudflare returns
    // them on the wire.
    const updated = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("UpdateOidc", {
        name: "alchemy-zt-idp-update-v2",
        type: "oidc",
        config: {
          ...oidcConfig,
          claims: ["email", "groups"],
        },
      }),
    );

    // Same IdP mutated in place — not a replacement.
    expect(updated.identityProviderId).toEqual(initial.identityProviderId);
    expect(updated.name).toEqual("alchemy-zt-idp-update-v2");

    const live = yield* getIdp(accountId, updated.identityProviderId);
    expect(live.name).toEqual("alchemy-zt-idp-update-v2");
    expect(
      [...((live.config as { claims?: string[] | null }).claims ?? [])].sort(),
    ).toEqual(["email", "groups"]);

    // Redeploying identical props is a no-op (still the same IdP).
    const noop = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("UpdateOidc", {
        name: "alchemy-zt-idp-update-v2",
        type: "oidc",
        config: {
          ...oidcConfig,
          claims: ["email", "groups"],
        },
      }),
    );
    expect(noop.identityProviderId).toEqual(initial.identityProviderId);

    yield* stack.destroy();
    yield* expectGone(accountId, initial.identityProviderId);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed IdP", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("ListOidc", {
        name: "alchemy-zt-idp-list",
        type: "oidc",
        config: oidcConfig,
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Access.IdentityProvider,
    );
    const all = yield* provider.list();

    expect(
      all.some((x) => x.identityProviderId === deployed.identityProviderId),
    ).toBe(true);

    yield* stack.destroy();
    yield* expectGone(deployed.accountId, deployed.identityProviderId);
  }).pipe(logLevel),
);

test.provider("changing the type replaces the IdP", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const oidc = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("ReplaceIdp", {
        name: "alchemy-zt-idp-replace",
        type: "oidc",
        config: oidcConfig,
      }),
    );

    // The name is the resource's cold-read identity, so a replacement
    // (type change) pairs with a rename — keeping the old name would make
    // the engine find the doomed sibling and refuse to adopt it.
    const github = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("ReplaceIdp", {
        name: "alchemy-zt-idp-replace-github",
        type: "github",
        config: {
          clientId: "alchemy-test-client",
          clientSecret: "alchemy-test-secret",
        },
      }),
    );

    // Type is immutable in our model — the engine must have replaced it.
    expect(github.identityProviderId).not.toEqual(oidc.identityProviderId);
    expect(github.type).toEqual("github");

    const live = yield* getIdp(accountId, github.identityProviderId);
    expect(live.type).toEqual("github");
    // The old IdP was deleted by the replacement.
    yield* expectGone(accountId, oidc.identityProviderId);

    yield* stack.destroy();
    yield* expectGone(accountId, github.identityProviderId);
  }).pipe(logLevel),
);
