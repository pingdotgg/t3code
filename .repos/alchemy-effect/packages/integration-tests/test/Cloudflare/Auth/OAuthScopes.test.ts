import {
  clientFor,
  deviceAuthorize,
  deviceToken,
  LEGACY_OAUTH_CLIENT_ID,
  OAUTH_CLIENT_ID,
  type OAuthCredentials,
} from "@alchemy.run/cloudflare/Auth/OAuthClient";
import {
  ALL_SCOPE_IDS,
  ALL_SCOPES,
  BASIC_SCOPES,
  customOAuthScopeDefaults,
  OAUTH_SCOPE_GROUPS,
  partitionOAuthScopes,
} from "@alchemy.run/cloudflare/Auth/OAuthScopes";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";

describe(
  "Cloudflare public OAuth client",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:auth", "local"] },
  () => {
    it("uses a duplicate-free catalog of allowed scopes", () => {
      const scopes = OAUTH_SCOPE_GROUPS.flatMap((group) => group.scopes);

      expect(scopes.length).toBeGreaterThan(0);
      expect(new Set(scopes).size).toBe(scopes.length);
    });

    it("partitions stored scopes against the current catalog", () => {
      // Profiles configured against an older OAuth client can hold scopes the
      // current client rejects; login must drop them instead of building an
      // authorize URL that Cloudflare refuses wholesale.
      const { valid, dropped } = partitionOAuthScopes([
        "workers-scripts.write",
        "account:read", // wrangler-era scope id, not in the alchemy catalog
        "zone.read",
      ]);
      expect(valid).toEqual(["workers-scripts.write", "zone.read"]);
      expect(dropped).toEqual(["account:read"]);
    });

    it("neither keeps nor drops the offline_access scope", () => {
      // The token response echoes offline_access into the stored scopes;
      // the authorize step adds it back itself.
      expect(partitionOAuthScopes(["zone.read", "offline_access"])).toEqual({
        valid: ["zone.read"],
        dropped: [],
      });
    });

    it("keeps the basic template inside the client allowlist", () => {
      expect(BASIC_SCOPES.length).toBeGreaterThan(0);
      expect(BASIC_SCOPES.every((scope) => scope in ALL_SCOPES)).toBe(true);
      expect(BASIC_SCOPES).toContain("memberships.read");
      expect(BASIC_SCOPES).toContain("workers-scripts.write");
      expect(BASIC_SCOPES).toContain("zone.read");
    });

    it("defaults to all scopes and restores valid scopes when reconfigured", () => {
      expect(
        customOAuthScopeDefaults({
          method: "oauth",
          scopes: ["workers-scripts.write", "account:read", "zone.read"],
          accountId: "account-id",
        }),
      ).toEqual(["workers-scripts.write", "zone.read"]);

      expect(customOAuthScopeDefaults({ method: "stored", credentialType: "apiToken" })).toEqual(
        ALL_SCOPE_IDS,
      );
    });

    const fakeFetch = (
      requests: Array<{ url: string; body: URLSearchParams }>,
      respond: (body: URLSearchParams) => { status: number; json: unknown },
    ) =>
      // SAFETY: the test double implements the callable fetch contract; Bun's
      // nonstandard static `preconnect` member is not used by FetchHttpClient.
      (async (input, init) => {
        const body = new URLSearchParams(await new Response(init?.body).text());
        requests.push({ url: input instanceof Request ? input.url : String(input), body });
        const { status, json } = respond(body);
        return new Response(JSON.stringify(json), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof globalThis.fetch;

    it("authorizes new logins with the cf CLI client's device flow", async () => {
      const requests: Array<{ url: string; body: URLSearchParams }> = [];
      let polls = 0;
      const fetch = fakeFetch(requests, (body) => {
        if (body.get("grant_type") === null) {
          return {
            status: 200,
            json: {
              device_code: "device",
              user_code: "ABCD-EFGH",
              verification_uri: "https://dash.cloudflare.com/oauth2/device",
              expires_in: 300,
              interval: 1,
            },
          };
        }
        polls++;
        return polls === 1
          ? { status: 400, json: { error: "authorization_pending" } }
          : polls === 2
            ? { status: 502, json: "<!DOCTYPE html>bad gateway" }
            : {
                status: 200,
                json: {
                  access_token: "access",
                  refresh_token: "refresh",
                  expires_in: 3600,
                  scope: "zone.read offline_access",
                },
              };
      });

      const credentials = await Effect.runPromise(
        Effect.gen(function* () {
          const authorization = yield* deviceAuthorize(["zone.read", "offline_access"]);
          expect(authorization.userCode).toBe("ABCD-EFGH");
          expect(authorization.verificationUriComplete).toBe(
            "https://dash.cloudflare.com/oauth2/device?user_code=ABCD-EFGH",
          );
          return yield* deviceToken(authorization);
        }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
      );

      expect(requests[0]?.url).toBe("https://dash.cloudflare.com/oauth2/device/auth");
      expect(requests[0]?.body.get("client_id")).toBe(OAUTH_CLIENT_ID);
      expect(requests[0]?.body.get("scope")).toBe("zone.read offline_access");
      expect(requests[1]?.body.get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:device_code",
      );
      expect(requests[1]?.body.get("device_code")).toBe("device");
      expect(polls).toBe(3);
      expect(credentials.clientId).toBe(OAUTH_CLIENT_ID);
      expect(Redacted.value(credentials.refresh)).toBe("refresh");
    });

    it("stops polling when the user denies the device authorization", async () => {
      const fetch = fakeFetch([], () => ({ status: 400, json: { error: "access_denied" } }));
      const error = await Effect.runPromise(
        deviceToken({
          deviceCode: "device",
          userCode: "ABCD-EFGH",
          verificationUri: "https://dash.cloudflare.com/oauth2/device",
          verificationUriComplete: "https://dash.cloudflare.com/oauth2/device?user_code=ABCD-EFGH",
          expiresIn: 300,
          interval: 1,
        }).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, fetch)),
      );
      expect(error._tag).toBe("DeviceAuthorizationDenied");
    });

    it("refuses a verification URL outside dash.cloudflare.com", async () => {
      const fetch = fakeFetch([], () => ({
        status: 200,
        json: {
          device_code: "device",
          user_code: "ABCD-EFGH",
          verification_uri: "https://evil.example/device",
          expires_in: 300,
        },
      }));
      const error = await Effect.runPromise(
        deviceAuthorize(["zone.read"]).pipe(
          Effect.flip,
          Effect.provideService(FetchHttpClient.Fetch, fetch),
        ),
      );
      expect(error._tag).toBe("UntrustedVerificationUriError");
    });

    it("keeps refreshing and revoking legacy-client grants with the legacy client", async () => {
      const requests: URLSearchParams[] = [];
      // SAFETY: the test double implements the callable fetch contract; Bun's
      // nonstandard static `preconnect` member is not used by FetchHttpClient.
      const fetch = (async (_input, init) => {
        requests.push(new URLSearchParams(await new Response(init?.body).text()));
        return new Response(JSON.stringify({ access_token: "next-access", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof globalThis.fetch;

      const current: OAuthCredentials = {
        type: "oauth",
        clientId: LEGACY_OAUTH_CLIENT_ID,
        access: Redacted.make("current-access"),
        refresh: Redacted.make("current-refresh"),
        expires: 0,
        scopes: ["workers-scripts.write"],
      };

      const withFetch = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
      const client = clientFor(current);
      if (client === undefined) throw new Error("legacy client not recognized");
      const next = await Effect.runPromise(withFetch(client.refresh(current)));
      await Effect.runPromise(withFetch(client.revoke(next)));

      expect(Redacted.value(next.refresh)).toBe("current-refresh");
      expect(next.scopes).toEqual(current.scopes);
      expect(next.clientId).toBe(current.clientId);
      expect(clientFor({ clientId: "unknown" })).toBeUndefined();
      expect(requests[0]?.get("grant_type")).toBe("refresh_token");
      expect(requests[0]?.get("client_id")).toBe(LEGACY_OAUTH_CLIENT_ID);
      expect(requests[1]?.get("client_id")).toBe(LEGACY_OAUTH_CLIENT_ID);
      expect(requests[0]?.has("redirect_uri")).toBe(false);
      expect(requests[1]?.get("token")).toBe("current-refresh");
      expect(requests[1]?.get("token_type_hint")).toBe("refresh_token");
      expect(requests[1]?.has("refresh_token")).toBe(false);
    });
  },
);
