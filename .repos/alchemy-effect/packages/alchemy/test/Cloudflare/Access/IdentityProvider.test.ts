import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import IdpLookupWorker from "./fixtures/idp-lookup-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// Ride out 403 blips (`Forbidden`) while the harness-minted token
// propagates across Cloudflare's edge. Zone-level when `zoneId` is set,
// account-level otherwise — mirroring the provider's own scoping.
const getIdp = (
  zoneId: string | undefined,
  accountId: string,
  identityProviderId: string,
) =>
  (zoneId !== undefined
    ? zeroTrust.getIdentityProviderForZone({ zoneId, identityProviderId })
    : zeroTrust.getIdentityProviderForAccount({ accountId, identityProviderId })
  ).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// A deleted IdP surfaces as `AccessIdentityProviderNotFound` (Cloudflare
// code 12135, `access.api.error.not_found`).
const expectGone = (
  zoneId: string | undefined,
  accountId: string,
  identityProviderId: string,
) =>
  getIdp(zoneId, accountId, identityProviderId).pipe(
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

    const live = yield* getIdp(undefined, accountId, idp.identityProviderId);
    expect(live.name).toEqual("alchemy-zt-idp-basic");
    expect(live.type).toEqual("oidc");
    // Cloudflare masks the client secret on read.
    expect(
      (live.config as { clientSecret?: string | null }).clientSecret ?? null,
    ).toBeNull();

    yield* stack.destroy();
    yield* expectGone(undefined, accountId, idp.identityProviderId);
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

    const live = yield* getIdp(
      undefined,
      accountId,
      updated.identityProviderId,
    );
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
    yield* expectGone(undefined, accountId, initial.identityProviderId);
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
    yield* expectGone(
      undefined,
      deployed.accountId,
      deployed.identityProviderId,
    );
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

    const live = yield* getIdp(undefined, accountId, github.identityProviderId);
    expect(live.type).toEqual("github");
    // The old IdP was deleted by the replacement.
    yield* expectGone(undefined, accountId, oidc.identityProviderId);

    yield* stack.destroy();
    yield* expectGone(undefined, accountId, github.identityProviderId);
  }).pipe(logLevel),
);

test.provider("zone-scoped IdP lifecycle (create, rename, destroy)", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();

    const idp = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("ZoneOidc", {
        zoneId,
        name: "alchemy-zt-idp-zone",
        type: "oidc",
        config: oidcConfig,
      }),
    );

    expect(idp.identityProviderId).toBeTruthy();
    expect(idp.zoneId).toEqual(zoneId);

    // Out-of-band via the zone-scoped route.
    const live = yield* getIdp(zoneId, accountId, idp.identityProviderId);
    expect(live.name).toEqual("alchemy-zt-idp-zone");
    expect(live.type).toEqual("oidc");

    // Rename converges in place — same IdP, same scope.
    const renamed = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("ZoneOidc", {
        zoneId,
        name: "alchemy-zt-idp-zone-v2",
        type: "oidc",
        config: oidcConfig,
      }),
    );
    expect(renamed.identityProviderId).toEqual(idp.identityProviderId);
    expect(renamed.name).toEqual("alchemy-zt-idp-zone-v2");

    yield* stack.destroy();
    yield* expectGone(zoneId, accountId, idp.identityProviderId);
  }).pipe(logLevel),
);

test.provider("moving an IdP between scopes replaces it", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();

    const accountScoped = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("ScopeMove", {
        name: "alchemy-zt-idp-scope-move",
        type: "oidc",
        config: oidcConfig,
      }),
    );
    expect(accountScoped.zoneId).toBeUndefined();

    // Adding zoneId is a scope change — a replacement, paired with a
    // rename so the doomed sibling isn't found by the cold-read scan.
    const zoneScoped = yield* stack.deploy(
      Cloudflare.Access.IdentityProvider("ScopeMove", {
        zoneId,
        name: "alchemy-zt-idp-scope-move-zone",
        type: "oidc",
        config: oidcConfig,
      }),
    );
    expect(zoneScoped.identityProviderId).not.toEqual(
      accountScoped.identityProviderId,
    );
    expect(zoneScoped.zoneId).toEqual(zoneId);

    // The old account-scoped IdP was deleted by the replacement.
    yield* expectGone(undefined, accountId, accountScoped.identityProviderId);

    yield* stack.destroy();
    yield* expectGone(zoneId, accountId, zoneScoped.identityProviderId);
  }).pipe(logLevel),
);

// Adoption + data-source coverage below. Live IdPs carry no ownership
// markers, so the provider locates them by name (or by type for the
// singleton `cloudflare` / `onetimepin` types) and the engine gates
// takeover behind `adopt(true)`.

const forbiddenRetryPolicy = {
  schedule: Schedule.exponential("500 millis"),
  times: 8,
} as const;

const retryForbidden = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e): boolean => e._tag === "Forbidden",
      ...forbiddenRetryPolicy,
    }),
  );

interface LiveIdp {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly type?: string | null;
}

const findLiveIdp = (
  accountId: string,
  predicate: (idp: { name: string; type: string }) => boolean,
) =>
  retryForbidden(
    zeroTrust.listIdentityProvidersForAccount.items({ accountId }).pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
      Effect.map((idp): LiveIdp | undefined => idp as LiveIdp | undefined),
    ),
  );

/**
 * Pull the {@link OwnedBySomeoneElse} value out of a Cause regardless of
 * whether the engine raised it as a typed failure or a defect.
 */
const findOwnedError = (
  cause: Cause.Cause<unknown>,
): OwnedBySomeoneElse | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is OwnedBySomeoneElse =>
        value instanceof OwnedBySomeoneElse,
    );

test.provider(
  "adoption — existing IdP errors without adopt, takes over with adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Create the IdP out-of-band so the stack has no state of its own for
      // it — exactly the "already configured in the dashboard" scenario. A
      // leftover from an interrupted run is fine: it is the same fixture.
      const NAME = "alchemy-zt-idp-adopt";
      const pre =
        (yield* findLiveIdp(accountId, (idp) => idp.name === NAME)) ??
        (yield* retryForbidden(
          zeroTrust.createIdentityProviderForAccount({
            accountId,
            name: NAME,
            type: "oidc",
            config: oidcConfig,
          }),
        ).pipe(Effect.map((created): LiveIdp => created as LiveIdp)));
      expect(pre.id).toBeTruthy();

      // Without `adopt`: Access IdPs carry no ownership markers, so the
      // engine cannot prove we created it and refuses to take it over.
      const error = yield* stack
        .deploy(
          Cloudflare.Access.IdentityProvider("AdoptOidc", {
            name: NAME,
            type: "oidc",
            config: oidcConfig,
          }),
        )
        .pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
        );
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      // With `adopt(true)`: the engine takes over the pre-existing IdP
      // (same physical id) — no duplicate create.
      const adopted = yield* stack.deploy(
        Cloudflare.Access.IdentityProvider("AdoptOidc", {
          name: NAME,
          type: "oidc",
          config: oidcConfig,
        }).pipe(adopt(true)),
      );
      expect(adopted.identityProviderId).toEqual(pre.id);

      // Adopted means owned — destroy deletes the live IdP.
      yield* stack.destroy();
      yield* expectGone(undefined, accountId, adopted.identityProviderId);
    }).pipe(logLevel),
);

// The `cloudflare` (WARP) IdP is an account singleton whose display name is
// `""` when provisioned from the Zero Trust dashboard. Both rounds run in
// ONE sequential case because the singleton is account-global and
// `test.provider` cases within a file run concurrently.
test.provider(
  "adoption — cloudflare-type IdP by empty name, then by type alone",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const findWarp = findLiveIdp(
        accountId,
        (idp) => idp.type === "cloudflare",
      );

      // Round 1 — the user-reported regression: an explicit `name: ""` must
      // match the live IdP (a truthiness check used to swallow `""` and
      // probe for a generated physical name instead, so the provider tried
      // to create a second singleton and failed).
      const pre1 =
        (yield* findWarp) ??
        (yield* retryForbidden(
          zeroTrust.createIdentityProviderForAccount({
            accountId,
            name: "",
            type: "cloudflare",
            config: { restrictToAccountMembers: true },
          }),
        ).pipe(Effect.map((created): LiveIdp => created as LiveIdp)));
      expect(pre1.id).toBeTruthy();

      const adopted1 = yield* stack.deploy(
        Cloudflare.Access.IdentityProvider("CloudflareIDP", {
          name: "",
          type: "cloudflare",
          config: { restrictToAccountMembers: true },
        }).pipe(adopt(true)),
      );
      expect(adopted1.identityProviderId).toEqual(pre1.id);
      expect(adopted1.name).toEqual("");

      yield* stack.destroy();
      yield* expectGone(undefined, accountId, adopted1.identityProviderId);

      // Round 2 — omitted name: singletons are located by type and keep
      // their observed display name (no rename to a generated physical
      // name).
      const pre2 = yield* retryForbidden(
        zeroTrust.createIdentityProviderForAccount({
          accountId,
          name: "",
          type: "cloudflare",
          config: { restrictToAccountMembers: true },
        }),
      ).pipe(Effect.map((created): LiveIdp => created as LiveIdp));
      expect(pre2.id).toBeTruthy();

      const adopted2 = yield* stack.deploy(
        Cloudflare.Access.IdentityProvider("CloudflareIDP", {
          type: "cloudflare",
          config: { restrictToAccountMembers: true },
        }).pipe(adopt(true)),
      );
      expect(adopted2.identityProviderId).toEqual(pre2.id);
      expect(adopted2.name).toEqual("");

      yield* stack.destroy();
      yield* expectGone(undefined, accountId, adopted2.identityProviderId);
    }).pipe(logLevel),
);

test.provider(
  "getIdentityProvider data source feeds another resource's props",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const NAME = "alchemy-zt-idp-lookup";

      // First deploy creates the IdP alone so the live IdP exists before
      // the next plan's data-source Output resolves.
      const idp = yield* stack.deploy(
        Cloudflare.Access.IdentityProvider("LookupOidc", {
          name: NAME,
          type: "oidc",
          config: oidcConfig,
        }),
      );

      // Second deploy consumes the lookup Output IN PLACE OF a resource
      // reference: `allowedIdps` receives the looked-up id — the "gate an
      // application on an IdP managed outside the stack" use case.
      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const same = yield* Cloudflare.Access.IdentityProvider("LookupOidc", {
            name: NAME,
            type: "oidc",
            config: oidcConfig,
          });
          yield* Cloudflare.Zone.Zone("TestZone", {
            name: zoneName,
          }).pipe(adopt(true));
          const app = yield* Cloudflare.Access.Application("LookupGatedApp", {
            type: "self_hosted",
            domain: `alchemy-test-idp-lookup.${zoneName}`,
            sessionDuration: "24h",
            allowedIdps: [
              Cloudflare.Access.getIdentityProvider({
                name: NAME,
              }).identityProviderId.as<string>(),
            ],
          });
          return {
            deployedId: same.identityProviderId,
            app,
            missing: Cloudflare.Access.getIdentityProvider({
              name: "alchemy-zt-idp-lookup-nonexistent",
            }),
          };
        }),
      );

      expect(result.deployedId).toEqual(idp.identityProviderId);
      expect(result.missing).toBeUndefined();
      expect(result.app.applicationId).toBeTruthy();

      // The application's allowed-IdP list must carry the looked-up id —
      // verified out-of-band against the live application.
      const liveApp = yield* zeroTrust
        .getAccessApplicationForAccount({
          accountId,
          appId: result.app.applicationId,
        })
        .pipe(
          Effect.retry({
            while: (e): boolean => e._tag === "Forbidden",
            ...forbiddenRetryPolicy,
          }),
        );
      const allowed =
        (liveApp as { allowedIdps?: ReadonlyArray<string | null> | null })
          .allowedIdps ?? [];
      expect(allowed).toContain(idp.identityProviderId);

      yield* stack.destroy();
      yield* expectGone(undefined, idp.accountId, idp.identityProviderId);
    }).pipe(logLevel),
);

class LookupNotServing extends Data.TaggedError("LookupNotServing")<{
  message: string;
}> {}

test.provider(
  "GetIdentityProvider binding resolves the IdP at runtime inside a Worker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const idp = yield* Cloudflare.Access.IdentityProvider(
            "WorkerLookupOidc",
            {
              name: "alchemy-zt-idp-worker-lookup",
              type: "oidc",
              config: oidcConfig,
            },
          );
          const worker = yield* IdpLookupWorker;
          return { idp, worker };
        }),
      );

      // Anchor on the expected marker, never a bare 200 — fresh workers.dev
      // hostnames serve a placeholder with 200 while propagating, and the
      // freshly-minted scoped token can 403 (→ worker 500) for ~30s.
      const client = yield* HttpClient.HttpClient;
      const body = yield* client.get(`${deployed.worker.url}/`).pipe(
        Effect.flatMap((res) =>
          Effect.gen(function* () {
            const text = yield* res.text;
            if (res.status !== 200 || !text.includes("identityProviderId")) {
              return yield* new LookupNotServing({
                message: `status=${res.status} body=${text.slice(0, 300)}`,
              });
            }
            return JSON.parse(text) as {
              identityProviderId: string | null;
              type: string | null;
            };
          }),
        ),
        Effect.retry({
          while: (e): boolean => e._tag === "LookupNotServing",
          schedule: Schedule.max([
            Schedule.min([
              Schedule.exponential("1 second"),
              Schedule.spaced("5 seconds"),
            ]),
            Schedule.recurs(15),
          ]),
        }),
      );

      expect(body.identityProviderId).toEqual(deployed.idp.identityProviderId);
      expect(body.type).toEqual("oidc");

      yield* stack.destroy();
      yield* expectGone(
        undefined,
        deployed.idp.accountId,
        deployed.idp.identityProviderId,
      );
    }).pipe(logLevel),
  { timeout: 180_000 },
);

// Compile-time contract of the per-type configs — never executed. The
// discriminated Props union must reject a config from the wrong provider
// type and enforce each type's required fields. Type-level assertions
// (not @ts-expect-error) so the checks don't depend on where tsc anchors
// a multi-line object-literal diagnostic.
type IdpProps = Cloudflare.Access.IdentityProviderProps;
type Extends<A, B> = [A] extends [B] ? true : false;
type Not<T extends boolean> = T extends true ? false : true;
type Assert<T extends true> = T;

// Valid shapes are accepted.
type _OkOidc = Assert<
  Extends<{ type: "oidc"; config: typeof oidcConfig }, IdpProps>
>;
type _OkPin = Assert<Extends<{ type: "onetimepin" }, IdpProps>>;
type _OkSaml = Assert<
  Extends<
    {
      type: "saml";
      config: {
        issuerUrl: string;
        ssoTargetUrl: string;
        idpPublicCerts: string[];
      };
      samlCertificateSetId: string;
    },
    IdpProps
  >
>;
// An OAuth-only config is rejected on an oidc IdP (missing endpoints).
type _BadOidc = Assert<
  Not<
    Extends<
      { type: "oidc"; config: { clientId: string; clientSecret: string } },
      IdpProps
    >
  >
>;
// azureAD requires directoryId.
type _BadAzure = Assert<
  Not<
    Extends<
      { type: "azureAD"; config: { clientId: string; clientSecret: string } },
      IdpProps
    >
  >
>;
// saml requires issuerUrl/ssoTargetUrl/idpPublicCerts.
type _BadSaml = Assert<
  Not<Extends<{ type: "saml"; config: { issuerUrl: string } }, IdpProps>>
>;
