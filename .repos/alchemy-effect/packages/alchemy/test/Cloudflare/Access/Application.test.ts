import * as AdoptPolicy from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as State from "@/State/State";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Self-hosted Access Applications require a domain that belongs to an
// *active* zone in the account (pending zones are rejected with "domain does
// not belong to zone"). Tests can't activate a fresh zone (that requires
// nameserver delegation), so we adopt the shared pre-existing active zone.
// It must stay on the default `retain` removal policy: it's registered via
// Cloudflare Registrar, and the API refuses to delete registrar zones.
const zoneName =
  process.env.CLOUDFLARE_TEST_ACCESS_ZONE_NAME ?? "alchemy-test-2.us";

test.provider(
  "create and delete a self_hosted application gated by a reusable policy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const domain = `alchemy-test-app.${zoneName}`;
      const { app, policy } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.Zone.Zone("TestZone", {
            name: zoneName,
          }).pipe(AdoptPolicy.adopt(true));
          const policy = yield* Cloudflare.Access.Policy("AllowExampleDomain", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          const app = yield* Cloudflare.Access.Application("SelfHostedApp", {
            type: "self_hosted",
            domain,
            sessionDuration: "24h",
            oauthConfiguration: {
              enabled: true,
              grant: {
                sessionDuration: "24h",
                accessTokenLifetime: "15m",
              },
              dynamicClientRegistration: {
                enabled: true,
                allowedUris: [],
                allowAnyOnLocalhost: true,
                allowAnyOnLoopback: true,
              },
            },
            policies: [policy.policyId],
          });
          return { app, policy };
        }),
      );

      expect(app.applicationId).toBeDefined();
      expect(app.type).toEqual("self_hosted");
      expect(app.domain).toEqual(domain);
      expect(app.aud.length).toBeGreaterThan(0);
      expect(app.oauthConfiguration?.enabled).toBe(true);
      expect(app.oauthConfiguration?.grant?.sessionDuration).toBe("24h");
      expect(app.oauthConfiguration?.grant?.accessTokenLifetime).toBe("15m");
      expect(app.oauthConfiguration?.dynamicClientRegistration?.enabled).toBe(
        true,
      );
      expect(
        app.oauthConfiguration?.dynamicClientRegistration?.allowedUris ?? [],
      ).toEqual([]);
      expect(policy.policyId.length).toBeGreaterThan(0);

      const live = yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: app.applicationId,
      });
      const liveRecord = live as unknown as {
        id?: string | null;
        type?: string | null;
        policies?: ReadonlyArray<{ id?: string | null }> | null;
        oauthConfiguration?: {
          enabled?: boolean | null;
          grant?: {
            sessionDuration?: string | null;
            accessTokenLifetime?: string | null;
          } | null;
          dynamicClientRegistration?: {
            enabled?: boolean | null;
            allowedUris?: ReadonlyArray<string | null> | null;
            allowAnyOnLocalhost?: boolean | null;
            allowAnyOnLoopback?: boolean | null;
          } | null;
        } | null;
      };
      expect(liveRecord.id).toEqual(app.applicationId);
      expect(liveRecord.type).toEqual("self_hosted");
      expect(liveRecord.policies?.length ?? 0).toBeGreaterThanOrEqual(1);
      const liveIds = (liveRecord.policies ?? []).map((p) => p.id);
      expect(liveIds).toContain(policy.policyId);
      expect(liveRecord.oauthConfiguration?.enabled).toBe(true);
      expect(liveRecord.oauthConfiguration?.grant?.sessionDuration).toBe("24h");
      expect(liveRecord.oauthConfiguration?.grant?.accessTokenLifetime).toBe(
        "15m",
      );
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration?.enabled,
      ).toBe(true);
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration?.allowedUris ??
          [],
      ).toEqual([]);
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration
          ?.allowAnyOnLocalhost,
      ).toBe(true);
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration
          ?.allowAnyOnLoopback,
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "create and delete a warp device-enrollment application",
  (stack) =>
    Effect.gen(function* () {
      const idp = process.env.CLOUDFLARE_TEST_GOOGLE_IDP_ID;
      if (!idp) {
        // Skip when no Google IdP is configured in the test account.
        return;
      }

      yield* stack.destroy();

      const app = yield* stack.deploy(
        Effect.gen(function* () {
          // Warp apps derive their domain from the auth domain — no zone needed.
          const policy = yield* Cloudflare.Access.Policy("WarpAllowDomain", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          return yield* Cloudflare.Access.Application("WarpEnroll", {
            type: "warp",
            name: "Alchemy Warp Test",
            sessionDuration: "720h",
            allowedIdps: [idp],
            autoRedirectToIdentity: true,
            policies: [policy.policyId],
          });
        }),
      );

      expect(app.type).toEqual("warp");
      // Cloudflare derives the warp domain as `${authDomain}/warp`.
      expect(app.domain.endsWith("/warp")).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider("list enumerates the deployed access application", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const domain = `alchemy-test-list-app.${zoneName}`;
    const app = yield* stack.deploy(
      Effect.gen(function* () {
        yield* Cloudflare.Zone.Zone("TestZone", {
          name: zoneName,
        }).pipe(AdoptPolicy.adopt(true));
        const policy = yield* Cloudflare.Access.Policy("ListAllowDomain", {
          name: "Allow example.com",
          decision: "allow",
          include: [{ emailDomain: { domain: "example.com" } }],
        });
        return yield* Cloudflare.Access.Application("ListApp", {
          type: "self_hosted",
          domain,
          sessionDuration: "24h",
          policies: [policy.policyId],
        });
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Access.Application,
    );

    // `list()` enumerates every Access application in the account. The
    // provider already rides out the transient enumeration failures internally
    // (the typed `AccessReferenceNotFound` from a sibling app mid-teardown
    // still referencing a deleted policy, plus throttling 403s), so here we
    // only poll until our own freshly created app becomes visible.
    const all = yield* provider.list().pipe(
      Effect.flatMap((rows) =>
        rows.some((a) => a.applicationId === app.applicationId)
          ? Effect.succeed(rows)
          : Effect.fail({ _tag: "AppNotListed" as const }),
      ),
      Effect.retry({
        while: (e) => e._tag === "AppNotListed",
        schedule: Schedule.spaced("2 seconds"),
        times: 15,
      }),
    );

    const match = all.find((a) => a.applicationId === app.applicationId);
    expect(match).toBeDefined();
    expect(match?.type).toEqual("self_hosted");
    expect(match?.aud.length).toBeGreaterThan(0);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "update policies in place keeps the applicationId stable",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const domain = `alchemy-test-update-policies.${zoneName}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.Zone.Zone("TestZone", {
            name: zoneName,
          }).pipe(AdoptPolicy.adopt(true));
          const allow = yield* Cloudflare.Access.Policy("UpdateAllow", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          return yield* Cloudflare.Access.Application("UpdatePolicies", {
            type: "self_hosted",
            domain,
            oauthConfiguration: {
              enabled: true,
              grant: {
                sessionDuration: "24h",
                accessTokenLifetime: "15m",
              },
              dynamicClientRegistration: {
                enabled: true,
                allowedUris: ["https://client.example.com/callback"],
                allowAnyOnLocalhost: true,
              },
            },
            policies: [allow.policyId],
          });
        }),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.Zone.Zone("TestZone", {
            name: zoneName,
          }).pipe(AdoptPolicy.adopt(true));
          const allow = yield* Cloudflare.Access.Policy("UpdateAllow", {
            name: "Allow example.com",
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          const deny = yield* Cloudflare.Access.Policy("UpdateDeny", {
            name: "Deny everyone else",
            decision: "deny",
            include: [{ everyone: {} }],
          });
          return yield* Cloudflare.Access.Application("UpdatePolicies", {
            type: "self_hosted",
            domain,
            // Update one managed OAuth leaf while preserving omitted fields.
            oauthConfiguration: {
              dynamicClientRegistration: {
                allowAnyOnLoopback: true,
              },
            },
            policies: [allow.policyId, deny.policyId],
          });
        }),
      );

      expect(updated.applicationId).toEqual(initial.applicationId);

      const live = yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: updated.applicationId,
      });
      const liveRecord = live as unknown as {
        policies?: ReadonlyArray<unknown> | null;
        oauthConfiguration?: {
          enabled?: boolean | null;
          grant?: {
            sessionDuration?: string | null;
            accessTokenLifetime?: string | null;
          } | null;
          dynamicClientRegistration?: {
            enabled?: boolean | null;
            allowedUris?: ReadonlyArray<string | null> | null;
            allowAnyOnLocalhost?: boolean | null;
            allowAnyOnLoopback?: boolean | null;
          } | null;
        } | null;
      };
      expect(liveRecord.policies?.length ?? 0).toEqual(2);
      // The partial desired body must merge over the live managed OAuth
      // configuration before the PUT-style application update.
      expect(liveRecord.oauthConfiguration?.enabled).toBe(true);
      expect(liveRecord.oauthConfiguration?.grant?.sessionDuration).toBe("24h");
      expect(liveRecord.oauthConfiguration?.grant?.accessTokenLifetime).toBe(
        "15m",
      );
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration?.enabled,
      ).toBe(true);
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration?.allowedUris,
      ).toEqual(["https://client.example.com/callback"]);
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration
          ?.allowAnyOnLocalhost,
      ).toBe(true);
      expect(
        liveRecord.oauthConfiguration?.dynamicClientRegistration
          ?.allowAnyOnLoopback,
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Regression test for the cold-recovery `read` fallback: after state loss
// (or a stage migration rebuilding state via the adoption probe) there is
// no persisted `applicationId`. Without the domain-match fallback the
// engine plans a blind `create` and Cloudflare accepts a DUPLICATE
// application on the same domain with a fresh `aud`. With it, the app is
// found by domain, surfaces as `Unowned`, and adopts cleanly under
// `adopt(true)` — same applicationId/aud, no duplicate.
test.provider(
  "cold-recovery: read matches an existing app by domain after state loss",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const domain = `alchemy-test-cold-read.${zoneName}`;
      const program = Effect.gen(function* () {
        yield* Cloudflare.Zone.Zone("TestZone", {
          name: zoneName,
        }).pipe(AdoptPolicy.adopt(true));
        const policy = yield* Cloudflare.Access.Policy("ColdReadAllow", {
          name: "Allow example.com (cold read)",
          decision: "allow",
          include: [{ emailDomain: { domain: "example.com" } }],
        });
        return yield* Cloudflare.Access.Application("ColdReadApp", {
          type: "self_hosted",
          domain,
          sessionDuration: "24h",
          policies: [policy.policyId],
        });
      });

      const first = yield* stack.deploy(program);
      expect(first.applicationId).toBeDefined();
      expect(first.aud.length).toBeGreaterThan(0);

      // Simulate state loss for the application only: the app still
      // exists in Cloudflare, but the engine has no applicationId.
      const state = yield* yield* State.State;
      yield* state.delete({
        stack: stack.name,
        stage: "test",
        fqn: "ColdReadApp",
      });

      // Without adopt, the domain-matched app is Unowned — the engine
      // must refuse the takeover rather than create a duplicate.
      const refused = yield* stack.deploy(program).pipe(Effect.flip);
      expect(refused).toBeInstanceOf(AdoptPolicy.OwnedBySomeoneElse);

      // With adopt, the SAME app is adopted: identity is preserved and
      // no duplicate application appears on the domain.
      const readopted = yield* stack.deploy(
        program.pipe(AdoptPolicy.adopt(true)),
      );
      expect(readopted.applicationId).toEqual(first.applicationId);
      expect(readopted.aud).toEqual(first.aud);

      const all = yield* zeroTrust.listAccessApplicationsForAccount
        .items({ accountId })
        .pipe(Stream.runCollect);
      const onDomain = Array.from(all).filter(
        (a) => (a as { domain?: string | null }).domain === domain,
      );
      expect(onDomain).toHaveLength(1);

      yield* stack.destroy();
    }).pipe(logLevel),
);

/** Structural view of live application policies for inline-policy asserts. */
interface LiveInlineApp {
  policies?: ReadonlyArray<{
    id?: string | null;
    decision?: string | null;
    name?: string | null;
    reusable?: boolean | null;
    sessionDuration?: string | null;
    include?: ReadonlyArray<unknown> | null;
    exclude?: ReadonlyArray<unknown> | null;
    require?: ReadonlyArray<unknown> | null;
  }> | null;
}

test.provider(
  "inline policies: scalar shorthand, update in place, switch to reusable, no mixing",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const domain = `alchemy-test-inline-policies.${zoneName}`;
      const makeApp = (
        policies: Cloudflare.Access.ApplicationProps["policies"],
      ) =>
        Effect.gen(function* () {
          yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(
            AdoptPolicy.adopt(true),
          );
          return yield* Cloudflare.Access.Application("InlinePolicyApp", {
            type: "self_hosted",
            domain,
            policies,
          });
        });

      // v1 — one inline policy via scalar shorthand.
      const first = yield* stack.deploy(
        makeApp([
          {
            decision: "allow",
            name: "primary",
            include: [{ emailDomain: "example.com" }],
          },
        ]),
      );
      const live1 = (yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: first.applicationId,
      })) as unknown as LiveInlineApp;
      expect(live1.policies?.length).toBe(1);
      expect(live1.policies![0].reusable).toBe(false);
      // Shorthand expanded to the wire shape on the way out.
      expect(live1.policies![0].include).toEqual([
        { emailDomain: { domain: "example.com" } },
      ]);
      const inlineId = live1.policies![0].id;
      expect(inlineId).toBeDefined();

      // v2 — mutate the same inline policy: more shorthand kinds, exclude,
      // require, session duration. The policy must update IN PLACE (same
      // id) — an id-less inline item in the update PUT would mint a fresh
      // policy.
      yield* stack.deploy(
        makeApp([
          {
            decision: "allow",
            name: "primary",
            include: [{ emailDomain: "example.com" }, "everyone"],
            exclude: [{ email: "intern@example.com" }],
            require: [{ geo: "US" }],
            sessionDuration: "12h",
          },
        ]),
      );
      const live2 = (yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: first.applicationId,
      })) as unknown as LiveInlineApp;
      expect(live2.policies?.length).toBe(1);
      expect(live2.policies![0].id).toBe(inlineId);
      expect(live2.policies![0].include).toEqual([
        { emailDomain: { domain: "example.com" } },
        { everyone: {} },
      ]);
      expect(live2.policies![0].exclude).toEqual([
        { email: { email: "intern@example.com" } },
      ]);
      expect(live2.policies![0].require).toEqual([
        { geo: { countryCode: "US" } },
      ]);
      expect(live2.policies![0].sessionDuration).toBe("12h");

      // v3 — switch the application from inline to a reusable Policy
      // resource (passed directly).
      const reusableProgram = Effect.gen(function* () {
        yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(
          AdoptPolicy.adopt(true),
        );
        const reusable = yield* Cloudflare.Access.Policy("InlineSwapPolicy", {
          name: "Reusable for inline-swap test",
          decision: "allow",
          include: [{ emailDomain: "example.com" }],
        });
        const app = yield* Cloudflare.Access.Application("InlinePolicyApp", {
          type: "self_hosted",
          domain,
          policies: [reusable],
        });
        return { app, reusable };
      });
      const { reusable } = yield* stack.deploy(reusableProgram);
      const live3 = (yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: first.applicationId,
      })) as unknown as LiveInlineApp;
      expect(live3.policies?.length).toBe(1);
      expect(live3.policies![0].id).toBe(reusable.policyId);
      expect(live3.policies![0].reusable).toBe(true);

      // Mixing inline and reusable forms on one application fails fast.
      const mixed = yield* stack
        .deploy(
          makeApp([
            reusable.policyId,
            {
              decision: "allow",
              include: [{ emailDomain: "example.com" }],
            },
          ]),
        )
        .pipe(Effect.flip);
      expect(String(mixed)).toMatch(/mix/i);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
