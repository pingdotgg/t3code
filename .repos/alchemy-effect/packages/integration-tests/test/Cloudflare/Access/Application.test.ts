import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as AdoptPolicy from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as State from "alchemy/State/State";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { testName } from "../../names.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Self-hosted Access Applications require a domain that belongs to an
// *active* zone in the account (pending zones are rejected with "domain does
// not belong to zone"). Tests can't activate a fresh zone (that requires
// nameserver delegation), so we adopt the shared pre-existing active zone.
// It must stay on the default `retain` removal policy: it's registered via
// Cloudflare Registrar, and the API refuses to delete registrar zones.
const zoneName = process.env.CLOUDFLARE_TEST_ACCESS_ZONE_NAME ?? "alchemy-test-2.us";

// Hostname-safe per-stage suffix, so concurrent runs by different users
// never fight over one application domain.
const stageLabel = (stage: string) => stage.toLowerCase().replace(/[^a-z0-9-]/g, "-");

test.provider(
  "create and delete a self_hosted application gated by a reusable policy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const domain = `${testName("alchemy-test-app")}.${zoneName}`;
      const { app, policy } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(AdoptPolicy.adopt(true));
          const policy = yield* Cloudflare.Access.Policy("AllowExampleDomain", {
            name: testName("Allow example.com"),
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          const app = yield* Cloudflare.Access.Application("SelfHostedApp", {
            type: "self_hosted",
            domain,
            sessionDuration: "24h",
            oauthConfiguration: {
              enabled: true,
              grant: { sessionDuration: "24h", accessTokenLifetime: "15m" },
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
      expect(app.oauthConfiguration?.dynamicClientRegistration?.enabled).toBe(true);
      expect(app.oauthConfiguration?.dynamicClientRegistration?.allowedUris ?? []).toEqual([]);
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
          grant?: { sessionDuration?: string | null; accessTokenLifetime?: string | null } | null;
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
      expect(liveRecord.oauthConfiguration?.grant?.accessTokenLifetime).toBe("15m");
      expect(liveRecord.oauthConfiguration?.dynamicClientRegistration?.enabled).toBe(true);
      expect(liveRecord.oauthConfiguration?.dynamicClientRegistration?.allowedUris ?? []).toEqual(
        [],
      );
      expect(liveRecord.oauthConfiguration?.dynamicClientRegistration?.allowAnyOnLocalhost).toBe(
        true,
      );
      expect(liveRecord.oauthConfiguration?.dynamicClientRegistration?.allowAnyOnLoopback).toBe(
        true,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "provider:cloudflare:zone", "live"],
  },
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
            name: testName("Allow example.com"),
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          return yield* Cloudflare.Access.Application("WarpEnroll", {
            type: "warp",
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
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

test.provider(
  "list enumerates the deployed access application",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const domain = `${testName("alchemy-test-list-app")}.${zoneName}`;
      const app = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(AdoptPolicy.adopt(true));
          const policy = yield* Cloudflare.Access.Policy("ListAllowDomain", {
            name: testName("Allow example.com"),
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

      const provider = yield* Provider.findProvider(Cloudflare.Access.Application);

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
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "provider:cloudflare:zone", "live"],
  },
);

test.provider(
  "update policies in place keeps the applicationId stable",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const domain = `${testName("alchemy-test-update-policies")}.${zoneName}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(AdoptPolicy.adopt(true));
          const allow = yield* Cloudflare.Access.Policy("UpdateAllow", {
            name: testName("Allow example.com"),
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          return yield* Cloudflare.Access.Application("UpdatePolicies", {
            type: "self_hosted",
            domain,
            oauthConfiguration: {
              enabled: true,
              grant: { sessionDuration: "24h", accessTokenLifetime: "15m" },
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
          yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(AdoptPolicy.adopt(true));
          const allow = yield* Cloudflare.Access.Policy("UpdateAllow", {
            name: testName("Allow example.com"),
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
          const deny = yield* Cloudflare.Access.Policy("UpdateDeny", {
            decision: "deny",
            include: [{ everyone: {} }],
          });
          return yield* Cloudflare.Access.Application("UpdatePolicies", {
            type: "self_hosted",
            domain,
            // Update one managed OAuth leaf while preserving omitted fields.
            oauthConfiguration: { dynamicClientRegistration: { allowAnyOnLoopback: true } },
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
          grant?: { sessionDuration?: string | null; accessTokenLifetime?: string | null } | null;
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
      expect(liveRecord.oauthConfiguration?.grant?.accessTokenLifetime).toBe("15m");
      expect(liveRecord.oauthConfiguration?.dynamicClientRegistration?.enabled).toBe(true);
      expect(liveRecord.oauthConfiguration?.dynamicClientRegistration?.allowedUris).toEqual([
        "https://client.example.com/callback",
      ]);
      expect(liveRecord.oauthConfiguration?.dynamicClientRegistration?.allowAnyOnLocalhost).toBe(
        true,
      );
      expect(liveRecord.oauthConfiguration?.dynamicClientRegistration?.allowAnyOnLoopback).toBe(
        true,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "provider:cloudflare:zone", "live"],
  },
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

      const domain = `${testName("alchemy-test-cold-read")}.${zoneName}`;
      const program = Effect.gen(function* () {
        yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(AdoptPolicy.adopt(true));
        const policy = yield* Cloudflare.Access.Policy("ColdReadAllow", {
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
      yield* state.delete({ stack: stack.name, stage: stack.stage, fqn: "ColdReadApp" });

      // Without adopt, the domain-matched app is Unowned — the engine
      // must refuse the takeover rather than create a duplicate.
      const refused = yield* stack.deploy(program).pipe(Effect.flip);
      expect(refused).toBeInstanceOf(AdoptPolicy.OwnedBySomeoneElse);

      // With adopt, the SAME app is adopted: identity is preserved and
      // no duplicate application appears on the domain.
      const readopted = yield* stack.deploy(program.pipe(AdoptPolicy.adopt(true)));
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
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "provider:cloudflare:zone", "live"],
  },
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

      const domain = `${testName("alchemy-test-inline-policies")}.${zoneName}`;
      const makeApp = (policies: Cloudflare.Access.ApplicationProps["policies"]) =>
        Effect.gen(function* () {
          yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(AdoptPolicy.adopt(true));
          return yield* Cloudflare.Access.Application("InlinePolicyApp", {
            type: "self_hosted",
            domain,
            policies,
          });
        });

      // v1 — one inline policy via scalar shorthand.
      const first = yield* stack.deploy(
        makeApp([
          { decision: "allow", name: "primary", include: [{ emailDomain: "example.com" }] },
        ]),
      );
      const live1 = (yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: first.applicationId,
      })) as unknown as LiveInlineApp;
      expect(live1.policies?.length).toBe(1);
      expect(live1.policies![0].reusable).toBe(false);
      // Shorthand expanded to the wire shape on the way out.
      expect(live1.policies![0].include).toEqual([{ emailDomain: { domain: "example.com" } }]);
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
      expect(live2.policies![0].exclude).toEqual([{ email: { email: "intern@example.com" } }]);
      expect(live2.policies![0].require).toEqual([{ geo: { countryCode: "US" } }]);
      expect(live2.policies![0].sessionDuration).toBe("12h");

      // v3 — switch the application from inline to a reusable Policy
      // resource (passed directly).
      const reusableProgram = Effect.gen(function* () {
        yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(AdoptPolicy.adopt(true));
        const reusable = yield* Cloudflare.Access.Policy("InlineSwapPolicy", {
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
            { decision: "allow", include: [{ emailDomain: "example.com" }] },
          ]),
        )
        .pipe(Effect.flip);
      expect(String(mixed)).toMatch(/mix/i);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "provider:cloudflare:zone", "live"],
    timeout: 300_000,
  },
);

test.provider(
  "adopts an existing application by id and keeps its unmanaged settings",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const name = `alchemy-test-adopt-by-id-${stageLabel(stack.stage)}`;
      const domain = `${name}.${zoneName}`;
      const existing = yield* zeroTrust.createAccessApplicationForAccount({
        accountId,
        type: "self_hosted",
        name,
        domain,
        sessionDuration: "24h",
        corsHeaders: {
          allowedOrigins: ["https://app.example.com"],
          allowedMethods: ["GET", "POST"],
          allowCredentials: true,
        },
        sameSiteCookieAttribute: "lax",
        httpOnlyCookieAttribute: true,
        pathCookieAttribute: true,
        skipInterstitial: true,
      });

      const program = (applicationId: string, sessionDuration: string) =>
        Effect.gen(function* () {
          yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(AdoptPolicy.adopt(true));
          return yield* Cloudflare.Access.Application("AdoptById", {
            applicationId,
            type: "self_hosted",
            name,
            domain,
            sessionDuration,
          });
        });

      // A declared id that does not exist fails rather than creating an
      // application with a new id and `aud`.
      const missingId = "00000000-0000-4000-8000-000000000000";
      const refused = yield* stack.deploy(program(missingId, "12h")).pipe(Effect.flip);
      expect(refused._tag).toEqual("DeclaredApplicationNotFound");
      const named = yield* zeroTrust.listAccessApplicationsForAccount.items({ accountId }).pipe(
        Stream.filter((app) => app.name === name),
        Stream.runCollect,
      );
      expect(Array.from(named, (app) => app.id)).toEqual([existing.id]);

      // No `--adopt` needed: naming the id is the adoption.
      const adopted = yield* stack.deploy(program(existing.id!, "12h"));
      expect(adopted.applicationId).toEqual(existing.id);
      expect(adopted.aud).toEqual(existing.aud);

      const live = (yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: existing.id!,
      })) as unknown as Record<string, any>;
      expect(live.sessionDuration).toEqual("12h");
      expect(live.corsHeaders?.allowedOrigins).toEqual(["https://app.example.com"]);
      expect(live.corsHeaders?.allowCredentials).toBe(true);
      expect(live.sameSiteCookieAttribute).toEqual("lax");
      expect(live.httpOnlyCookieAttribute).toBe(true);
      expect(live.pathCookieAttribute).toBe(true);
      expect(live.skipInterstitial).toBe(true);

      yield* stack.destroy();

      const gone = yield* zeroTrust
        .getAccessApplicationForAccount({ accountId, appId: existing.id! })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("AccessApplicationNotFound", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "provider:cloudflare:zone", "live"],
  },
);

test.provider(
  "adopted application keeps live policy links and hostnames it does not declare",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const name = `alchemy-test-adopt-keeps-links-${stageLabel(stack.stage)}`;
      const domain = `${name}.${zoneName}`;
      const extraDomain = `${name}-2.${zoneName}`;
      const policy = yield* zeroTrust.createAccessPolicy({
        accountId,
        name,
        decision: "allow",
        include: [{ emailDomain: { domain: "example.com" } }],
      });
      // The policy is outside the stack: delete it even when the test fails,
      // after the application releases it.
      const cleanup = stack
        .destroy()
        .pipe(
          Effect.andThen(
            zeroTrust
              .deleteAccessPolicy({ accountId, policyId: policy.id! })
              .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 5 })),
          ),
          Effect.orDie,
        );

      yield* Effect.gen(function* () {
        const existing = yield* zeroTrust.createAccessApplicationForAccount({
          accountId,
          type: "self_hosted",
          name,
          domain,
          destinations: [
            { type: "public", uri: domain },
            { type: "public", uri: extraDomain },
          ],
          sessionDuration: "24h",
          policies: [policy.id!],
        });

        // The changed `sessionDuration` forces a PUT, which must keep the
        // undeclared policy link and hostnames.
        const adopted = yield* stack.deploy(
          Effect.gen(function* () {
            yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(
              AdoptPolicy.adopt(true),
            );
            return yield* Cloudflare.Access.Application("AdoptKeepsLinks", {
              applicationId: existing.id!,
              type: "self_hosted",
              name,
              domain,
              sessionDuration: "12h",
            });
          }),
        );
        expect(adopted.updatedAt).toBeDefined();

        const live = (yield* zeroTrust.getAccessApplicationForAccount({
          accountId,
          appId: existing.id!,
        })) as unknown as {
          sessionDuration?: string;
          policies?: ReadonlyArray<{ id?: string }>;
          destinations?: ReadonlyArray<{ uri?: string }>;
        };
        expect(live.sessionDuration).toEqual("12h");
        expect(live.policies?.map((p) => p.id)).toEqual([policy.id]);
        expect(live.destinations?.map((d) => d.uri)).toEqual([domain, extraDomain]);
      }).pipe(Effect.ensuring(cleanup));
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "provider:cloudflare:zone", "live"],
  },
);

test.provider(
  "manages CORS, cookie and preflight settings",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const program = (props: Partial<Cloudflare.Access.ApplicationProps>) =>
        Effect.gen(function* () {
          yield* Cloudflare.Zone.Zone("TestZone", { name: zoneName }).pipe(AdoptPolicy.adopt(true));
          const cors = yield* Cloudflare.Access.Application("CorsApp", {
            type: "self_hosted",
            domain: `alchemy-test-cors-${stageLabel(stack.stage)}.${zoneName}`,
            ...props,
          });
          const preflight = yield* Cloudflare.Access.Application("PreflightApp", {
            type: "self_hosted",
            domain: `alchemy-test-preflight-${stageLabel(stack.stage)}.${zoneName}`,
            optionsPreflightBypass: true,
          });
          return { cors, preflight };
        });
      const getLive = (appId: string) =>
        zeroTrust
          .getAccessApplicationForAccount({ accountId, appId })
          .pipe(Effect.map((app) => app as unknown as Record<string, any>));

      const { cors, preflight } = yield* stack.deploy(
        program({
          corsHeaders: {
            allowedOrigins: ["https://app.example.com"],
            allowedMethods: ["GET"],
          },
          sameSiteCookieAttribute: "strict",
          httpOnlyCookieAttribute: true,
          enableBindingCookie: true,
          eagerRedirectCookieSetting: false,
        }),
      );
      const live1 = yield* getLive(cors.applicationId);
      expect(live1.corsHeaders?.allowedOrigins).toEqual(["https://app.example.com"]);
      expect(live1.corsHeaders?.allowedMethods).toEqual(["GET"]);
      expect(live1.sameSiteCookieAttribute).toEqual("strict");
      expect(live1.httpOnlyCookieAttribute).toBe(true);
      expect(live1.enableBindingCookie).toBe(true);
      expect(live1.eagerRedirectCookieSetting).toBe(false);
      expect((yield* getLive(preflight.applicationId)).optionsPreflightBypass).toBe(true);

      // Settings dropped from the props are left as they are live.
      yield* stack.deploy(
        program({
          corsHeaders: { allowedMethods: ["GET", "POST"] },
          sameSiteCookieAttribute: "lax",
        }),
      );
      const live2 = yield* getLive(cors.applicationId);
      expect(live2.corsHeaders?.allowedOrigins).toEqual(["https://app.example.com"]);
      expect(live2.corsHeaders?.allowedMethods?.toSorted()).toEqual(["GET", "POST"]);
      expect(live2.sameSiteCookieAttribute).toEqual("lax");
      expect(live2.httpOnlyCookieAttribute).toBe(true);
      expect(live2.enableBindingCookie).toBe(true);
      expect(live2.eagerRedirectCookieSetting).toBe(false);

      const { cors: eager } = yield* stack.deploy(program({ eagerRedirectCookieSetting: true }));
      expect(eager.applicationId).toEqual(cors.applicationId);
      expect(eager.aud).toEqual(cors.aud);
      const live3 = yield* getLive(eager.applicationId);
      expect(live3.eagerRedirectCookieSetting).toBe(true);
      expect(live3.corsHeaders?.allowedOrigins).toEqual(["https://app.example.com"]);
      expect(live3.corsHeaders?.allowedMethods?.toSorted()).toEqual(["GET", "POST"]);
      expect(live3.sameSiteCookieAttribute).toEqual("lax");
      expect(live3.httpOnlyCookieAttribute).toBe(true);
      expect(live3.enableBindingCookie).toBe(true);

      // A neighboring setting update keeps the now-enabled Eager Redirect value.
      const { cors: final } = yield* stack.deploy(program({ sameSiteCookieAttribute: "strict" }));
      expect(final.applicationId).toEqual(cors.applicationId);
      expect(final.aud).toEqual(cors.aud);
      const live4 = yield* getLive(final.applicationId);
      expect(live4.eagerRedirectCookieSetting).toBe(true);
      expect(live4.corsHeaders?.allowedOrigins).toEqual(["https://app.example.com"]);
      expect(live4.corsHeaders?.allowedMethods?.toSorted()).toEqual(["GET", "POST"]);
      expect(live4.sameSiteCookieAttribute).toEqual("strict");
      expect(live4.httpOnlyCookieAttribute).toBe(true);
      expect(live4.enableBindingCookie).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "provider:cloudflare:zone", "live"],
  },
);

test.provider(
  "SAML and OIDC SaaS applications",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const program = (redirectUri: string) =>
        Effect.gen(function* () {
          const saml = yield* Cloudflare.Access.Application("SamlApp", {
            type: "saas",
            saasApp: {
              authType: "saml",
              spEntityId: "https://saml.example.com",
              consumerServiceUrl: "https://saml.example.com/acs",
              nameIdFormat: "email",
            },
          });
          const oidc = yield* Cloudflare.Access.Application("OidcApp", {
            type: "saas",
            saasApp: {
              authType: "oidc",
              redirectUris: [redirectUri],
              grantTypes: ["authorization_code"],
              scopes: ["openid", "email", "profile"],
            },
          });
          return { saml, oidc };
        });

      const first = yield* stack.deploy(program("https://oidc.example.com/cb"));
      const samlApp = first.saml.saasApp as Record<string, any>;
      expect(first.saml.type).toEqual("saas");
      expect(samlApp.spEntityId).toEqual("https://saml.example.com");
      expect(samlApp.ssoEndpoint).toBeDefined();
      expect(samlApp.publicKey).toBeDefined();
      const oidcApp = first.oidc.saasApp as Record<string, any>;
      expect(oidcApp.clientId).toBeDefined();
      expect(oidcApp.clientSecret).toBeUndefined();

      const second = yield* stack.deploy(program("https://oidc.example.com/callback"));
      expect(second.oidc.applicationId).toEqual(first.oidc.applicationId);
      const live = (yield* zeroTrust.getAccessApplicationForAccount({
        accountId,
        appId: second.oidc.applicationId,
      })) as unknown as { saasApp?: Record<string, any> };
      expect(live.saasApp?.redirectUris).toEqual(["https://oidc.example.com/callback"]);
      // The client id survives the update — clients stay configured.
      expect(live.saasApp?.clientId).toEqual(oidcApp.clientId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);
