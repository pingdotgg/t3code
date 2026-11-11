import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// The Access organization is an account-wide singleton whose auth domain is
// allocated once and effectively immutable — the tests adopt the LIVE org
// (auth domain read from the account, or CLOUDFLARE_TEST_AUTH_DOMAIN) and
// restore every setting they toggle. The standing test account has a Zero
// Trust org, so they run by default; set CLOUDFLARE_TEST_ACCESS_ORG=0 to skip
// them on an account whose org must not be touched.
const skip = process.env.CLOUDFLARE_TEST_ACCESS_ORG === "0";

const customPagesEntitled = !!process.env.CLOUDFLARE_TEST_ACCESS_CUSTOM_PAGES;
const brandingDir = pathe.resolve(import.meta.dirname, "fixtures/branding");

const resolveAuthDomain = (accountId: string) =>
  process.env.CLOUDFLARE_TEST_AUTH_DOMAIN
    ? Effect.succeed(process.env.CLOUDFLARE_TEST_AUTH_DOMAIN)
    : zeroTrust.listOrganizationsForAccount({ accountId }).pipe(
        Effect.map((org) => {
          expect(org.authDomain).toBeTruthy();
          return org.authDomain!;
        }),
      );
// The organization's settings as an update body, to restore it after a test.
// A `serviceTokenInactivity` without an `action` is left out: Cloudflare
// rejects the bare `{ enabled: false }` shape it returns.
const restorable = (accountId: string, org: zeroTrust.ListOrganizationsResponse) => ({
  accountId,
  authDomain: org.authDomain ?? undefined,
  name: org.name ?? undefined,
  allowAuthenticateViaWarp: org.allowAuthenticateViaWarp ?? undefined,
  autoRedirectToIdentity: org.autoRedirectToIdentity ?? undefined,
  isUiReadOnly: org.isUiReadOnly ?? undefined,
  sessionDuration: org.sessionDuration ?? undefined,
  warpAuthSessionDuration: org.warpAuthSessionDuration ?? undefined,
  userSeatExpirationInactiveTime: org.userSeatExpirationInactiveTime ?? undefined,
  uiReadOnlyToggleReason: org.uiReadOnlyToggleReason ?? undefined,
  denyUnmatchedRequests: org.denyUnmatchedRequests ?? undefined,
  denyUnmatchedRequestsExemptedZoneNames: org.denyUnmatchedRequestsExemptedZoneNames
    ? [...org.denyUnmatchedRequestsExemptedZoneNames]
    : undefined,
  disableEndUserAppCreation: org.disableEndUserAppCreation ?? undefined,
  strictServiceTokenAuth: org.strictServiceTokenAuth ?? undefined,
  mfaRequiredForAllApps: org.mfaRequiredForAllApps ?? undefined,
  warp_auth_non_browser_401: org.warp_auth_non_browser_401 ?? undefined,
  loginDesign: withoutNulls(org.loginDesign),
  customPages: withoutNulls(org.customPages),
  mfaConfig: withoutNulls(org.mfaConfig),
  mfaPivKeyRequirements: withoutNulls(org.mfaPivKeyRequirements),
  serviceTokenInactivity: org.serviceTokenInactivity?.action
    ? withoutNulls(org.serviceTokenInactivity)
    : undefined,
});

const withoutNulls = <T extends object>(value: T | null | undefined) =>
  value
    ? (Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null)) as {
        [K in keyof T]: Exclude<T[K], null>;
      })
    : undefined;

// Every deploy converges the whole organization, so a test that deploys it
// puts the account's organization back the way it found it.
const restoringOrganization = <A, E, R>(test: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const original = yield* zeroTrust.listOrganizationsForAccount({ accountId });
    return yield* test.pipe(
      Effect.ensuring(
        zeroTrust.updateOrganizationForAccount(restorable(accountId, original)).pipe(Effect.ignore),
      ),
    );
  });

// Both cases mutate the same account-wide Access organization singleton; run
// them serially so they don't corrupt each other under the global concurrent
// test config.
describe.sequential(
  "Organization",
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
  () => {
    test.provider.skipIf(skip)("adopts the existing Access organization", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const authDomain = yield* resolveAuthDomain(accountId);

        const org = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Organization("Org", {
              authDomain,
              name: authDomain,
            });
          }),
        );

        expect(org.accountId).toEqual(accountId);
        expect(org.authDomain).toEqual(authDomain);

        const live = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        expect(live.authDomain).toEqual(authDomain);

        // Singleton: delete is a no-op, so destroy must NOT remove the org.
        yield* stack.destroy();
        const stillThere = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        expect(stillThere.authDomain).toEqual(authDomain);
      }).pipe(restoringOrganization, logLevel),
    );

    // Same gate as above: toggling allow_authenticate_via_warp mutates the
    // account's live singleton org (restored at the end).
    test.provider.skipIf(skip)("toggles allow_authenticate_via_warp and restores", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const authDomain = yield* resolveAuthDomain(accountId);

        const original = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        const originalWarp = original.allowAuthenticateViaWarp ?? false;
        const originalName = original.name ?? authDomain;

        // Step 1 — set to true.
        const enabled = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Organization("Org", {
              authDomain,
              name: originalName,
              allowAuthenticateViaWarp: true,
            });
          }),
        );
        expect(enabled.allowAuthenticateViaWarp).toEqual(true);
        const liveEnabled = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        expect(liveEnabled.allowAuthenticateViaWarp).toEqual(true);

        // Step 2 — flip to false.
        const disabled = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Organization("Org", {
              authDomain,
              name: originalName,
              allowAuthenticateViaWarp: false,
            });
          }),
        );
        expect(disabled.allowAuthenticateViaWarp).toEqual(false);
        const liveDisabled = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        expect(liveDisabled.allowAuthenticateViaWarp).toEqual(false);

        // Restore to original value via a final deploy so the account
        // isn't left mutated by the test.
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Organization("Org", {
              authDomain,
              name: originalName,
              allowAuthenticateViaWarp: originalWarp,
            });
          }),
        );

        yield* stack.destroy();
      }).pipe(restoringOrganization, logLevel),
    );

    // Every setting is declarable, and a deploy converges the whole
    // organization: a setting dropped from the props goes back to its default.
    test.provider.skipIf(skip)("converges declared and undeclared settings", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const authDomain = yield* resolveAuthDomain(accountId);
        const original = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        const name = original.name ?? authDomain;

        const org = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Organization("Org", {
              authDomain,
              name,
              sessionDuration: "13h",
              loginDesign: { footerText: "alchemy footer" },
              disableEndUserAppCreation: true,
              warpAuthNonBrowser401: true,
              mfaConfig: { allowedAuthenticators: ["totp"], sessionDuration: "5h" },
              mfaPivKeyRequirements: { pinPolicy: "always", touchPolicy: "always" },
              serviceTokenInactivity: {
                enabled: true,
                action: "disable",
                inactivityThresholdDays: 365,
              },
            });
          }),
        );
        expect(org.mfaConfig?.allowedAuthenticators).toEqual(["totp"]);
        expect(org.disableEndUserAppCreation).toEqual(true);

        const live = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        expect(live.sessionDuration).toEqual("13h");
        expect(live.loginDesign?.footerText).toEqual("alchemy footer");
        expect(live.disableEndUserAppCreation).toEqual(true);
        expect(live.warp_auth_non_browser_401).toEqual(true);
        expect(live.mfaConfig?.allowedAuthenticators).toEqual(["totp"]);
        expect(live.mfaConfig?.sessionDuration).toEqual("5h");
        expect(live.mfaPivKeyRequirements?.pinPolicy).toEqual("always");
        expect(live.serviceTokenInactivity?.enabled).toEqual(true);
        expect(live.serviceTokenInactivity?.inactivityThresholdDays).toEqual(365);

        // Change MFA, drop everything else.
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Organization("Org", {
              authDomain,
              name,
              mfaConfig: { allowedAuthenticators: ["totp", "security_key"], sessionDuration: "8h" },
            });
          }),
        );

        const converged = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        expect(converged.mfaConfig?.allowedAuthenticators).toEqual(["totp", "security_key"]);
        expect(converged.mfaConfig?.sessionDuration).toEqual("8h");
        expect(converged.sessionDuration ?? undefined).not.toEqual("13h");
        expect(converged.loginDesign?.footerText ?? undefined).toBeUndefined();
        expect(converged.disableEndUserAppCreation ?? false).toEqual(false);
        expect(converged.warp_auth_non_browser_401 ?? false).toEqual(false);
        expect(converged.mfaPivKeyRequirements ?? undefined).toBeUndefined();
        expect(converged.serviceTokenInactivity?.enabled ?? false).toEqual(false);

        yield* stack.destroy();
      }).pipe(restoringOrganization, logLevel),
    );

    // Branding lives in the repo: the logo is served by an assets-only
    // Worker and the block page HTML is read from a file.
    test.provider.skipIf(skip)("brands the login page from files in the repo", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const authDomain = yield* resolveAuthDomain(accountId);
        const original = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        const fs = yield* FileSystem.FileSystem;

        const { org, logoUrl, forbiddenPageId } = yield* stack.deploy(
          Effect.gen(function* () {
            const branding = yield* Cloudflare.Worker("Branding", {
              assets: brandingDir + "/public",
              workersDev: true,
            });
            // Access custom pages need an entitled account.
            const forbidden = customPagesEntitled
              ? yield* Cloudflare.Access.CustomPage("Forbidden", {
                  type: "forbidden",
                  customHtml: yield* fs.readFileString(brandingDir + "/forbidden.html"),
                })
              : undefined;
            const org = yield* Cloudflare.Access.Organization("Org", {
              authDomain,
              name: original.name ?? authDomain,
              loginDesign: {
                logoPath: Output.interpolate`${branding.url}/logo.svg`,
                backgroundColor: "#111111",
                textColor: "#ffffff",
              },
              customPages: forbidden ? { forbidden: forbidden.customPageId } : undefined,
            });
            return {
              org,
              logoUrl: Output.interpolate`${branding.url}/logo.svg`,
              forbiddenPageId: forbidden?.customPageId,
            };
          }),
        );

        const live = yield* zeroTrust.listOrganizationsForAccount({ accountId });
        expect(live.loginDesign?.logoPath).toEqual(logoUrl);
        expect(live.loginDesign?.backgroundColor).toEqual("#111111");
        if (forbiddenPageId) {
          expect(live.customPages?.forbidden).toEqual(forbiddenPageId);
          expect(org.customPages?.forbidden).toEqual(forbiddenPageId);
        }
        yield* expectUrlContains(logoUrl, "alchemy-access-logo");

        // Unset the custom page before destroy deletes it.
        yield* zeroTrust.updateOrganizationForAccount(restorable(accountId, original));
        yield* stack.destroy();
      }).pipe(restoringOrganization, logLevel),
    );

    // Canonical `list()` test (account singleton): there is no enumeration API
    // for the Access organization, so `list()` reads the single account-wide
    // org via the same path `read` uses and returns the one-element array (or
    // `[]` when the account has never enabled Zero Trust). This is read-only —
    // it does not mutate the singleton — so it runs unconditionally.
    test.provider("list returns the account Access organization", (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const provider = yield* Provider.findProvider(Cloudflare.Access.Organization);
        const all = yield* provider.list();

        // Singleton: zero (Zero Trust never enabled) or exactly one.
        expect(all.length).toBeLessThanOrEqual(1);
        for (const org of all) {
          expect(org.accountId).toEqual(accountId);
          expect(typeof org.authDomain).toBe("string");
          expect(typeof org.name).toBe("string");
        }

        // `stack` is unused (no resource is deployed), but keep the destroy
        // bookend so the harness state stays clean.
        yield* stack.destroy();
      }).pipe(logLevel),
    );
  },
);
