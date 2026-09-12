import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  EnvironmentId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import { fetchRemoteSessionState } from "../authorization/remote.ts";
import { ClientPresentation, SshEnvironmentGateway } from "../platform/capabilities.ts";
import { BearerConnectionCredential, BearerConnectionProfile } from "./catalog.ts";
import { BearerConnectionTarget } from "./model.ts";
import {
  prepareBearerConnectionUpdate,
  preparePairingRegistration,
  prepareSshRegistration,
} from "./onboarding.ts";

const CLIENT_PRESENTATION_LAYER = Layer.succeed(
  ClientPresentation,
  ClientPresentation.of({
    metadata: {
      label: "T3 Code Test",
      deviceType: "desktop",
      os: "Test OS",
    },
  }),
);

function pairingHttpLayer(
  calls: Array<{ readonly url: string; readonly init: RequestInit }>,
  options?: {
    readonly failDescriptor?: boolean;
    readonly grantScopes?: ReadonlyArray<AuthEnvironmentScope>;
  },
) {
  const grantScopes = options?.grantScopes ?? AuthStandardClientScopes;
  let sessionScopes: ReadonlyArray<string> = [];
  const fetchFn = ((input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/.well-known/t3/environment")) {
      if (options?.failDescriptor === true) {
        return Promise.resolve(
          Response.json({ message: "descriptor unavailable" }, { status: 503 }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "environment-paired",
          label: "Paired environment",
          platform: {
            os: "linux",
            arch: "x64",
          },
          serverVersion: "0.0.0-test",
          capabilities: {
            repositoryIdentity: true,
          },
        }),
      );
    }

    if (url.endsWith("/oauth/token")) {
      const body =
        init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init.body);
      const requestedScope = new URLSearchParams(body).get("scope");
      sessionScopes = requestedScope === null ? grantScopes : requestedScope.split(" ");
      if (!sessionScopes.every((scope) => grantScopes.some((granted) => granted === scope))) {
        return Promise.resolve(
          Response.json(
            {
              _tag: "EnvironmentRequestInvalidError",
              code: "invalid_request",
              reason: "scope_not_granted",
              traceId: "pairing-scope-test",
            },
            { status: 400 },
          ),
        );
      }
      return Promise.resolve(
        Response.json({
          access_token: "bearer-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: sessionScopes.join(" "),
        }),
      );
    }

    if (url.endsWith("/api/auth/session")) {
      return Promise.resolve(
        Response.json({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["bearer-access-token"],
            sessionCookieName: "t3_session",
          },
          scopes: sessionScopes,
          sessionMethod: "bearer-access-token",
        }),
      );
    }

    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;

  return remoteHttpClientLayer(fetchFn);
}

describe("connection onboarding", () => {
  it.effect("prepares a persisted bearer registration from pairing details", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(Layer.mergeAll(CLIENT_PRESENTATION_LAYER, pairingHttpLayer(calls))));

      expect(registration).toMatchObject({
        _tag: "BearerConnectionRegistration",
        target: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired",
        },
        profile: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired",
          httpBaseUrl: "https://remote.example.test/",
          wsBaseUrl: "wss://remote.example.test/",
        },
        credential: {
          token: "bearer-token",
        },
      });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
        "https://remote.example.test/oauth/token",
      ]);

      const tokenRequest = calls.find((call) => call.url.endsWith("/oauth/token"));
      const tokenBody =
        tokenRequest?.init.body instanceof Uint8Array
          ? new TextDecoder().decode(tokenRequest.init.body)
          : String(tokenRequest?.init.body);
      const tokenParams = new URLSearchParams(tokenBody);
      expect(tokenParams.get("subject_token")).toBe("pairing-token");
      expect(tokenParams.has("scope")).toBe(false);
      expect(tokenParams.get("client_label")).toBe("T3 Code Test");
      expect(tokenParams.get("client_device_type")).toBe("desktop");
      expect(tokenParams.get("client_os")).toBe("Test OS");
    }),
  );

  for (const { label, scopes } of [
    { label: "read-only", scopes: ["orchestration:read"] },
    { label: "administrative", scopes: AuthAdministrativeScopes },
  ] as const) {
    it.effect(`preserves the ${label} grant when pairing a remote environment`, () =>
      Effect.gen(function* () {
        const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
        const httpLayer = pairingHttpLayer(calls, { grantScopes: scopes });
        const registration = yield* preparePairingRegistration({
          host: "remote.example.test",
          pairingCode: "pairing-token",
        }).pipe(Effect.provide(Layer.mergeAll(CLIENT_PRESENTATION_LAYER, httpLayer)));

        const session = yield* fetchRemoteSessionState({
          httpBaseUrl: registration.profile.httpBaseUrl,
          bearerToken: registration.credential.token,
        }).pipe(Effect.provide(httpLayer));

        expect(session.authenticated).toBe(true);
        expect(session.scopes).toEqual(scopes);
      }),
    );
  }

  it.effect("does not consume a pairing credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];

      yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CLIENT_PRESENTATION_LAYER,
            pairingHttpLayer(calls, { failDescriptor: true }),
          ),
        ),
        Effect.flip,
      );

      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("rejects invalid pairing details before making a request", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "",
        pairingCode: "",
      }).pipe(
        Effect.provide(Layer.mergeAll(CLIENT_PRESENTATION_LAYER, pairingHttpLayer(calls))),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
        message: "Enter a backend URL.",
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("updates bearer metadata while preserving the credential and identity", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-paired");
      const registration = yield* prepareBearerConnectionUpdate({
        input: {
          environmentId,
          label: "  Renamed environment  ",
          httpBaseUrl: "http://100.65.180.100:3773/path",
        },
        entry: Option.some({
          target: new BearerConnectionTarget({
            environmentId,
            label: "Old label",
            connectionId: "bearer:environment-paired",
          }),
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: "bearer:environment-paired",
              environmentId,
              label: "Old label",
              httpBaseUrl: "http://old.example.test/",
              wsBaseUrl: "ws://old.example.test/",
            }),
          ),
        }),
        credential: Option.some(new BearerConnectionCredential({ token: "bearer-token" })),
      });

      expect(registration).toMatchObject({
        target: {
          environmentId,
          label: "Renamed environment",
          connectionId: "bearer:environment-paired",
        },
        profile: {
          environmentId,
          label: "Renamed environment",
          httpBaseUrl: "http://100.65.180.100:3773/",
          wsBaseUrl: "ws://100.65.180.100:3773/",
        },
        credential: { token: "bearer-token" },
      });
    }),
  );

  it.effect("prepares an SSH registration from the provisioned platform environment", () =>
    Effect.gen(function* () {
      const target = {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      };
      const registration = yield* prepareSshRegistration({
        target,
      }).pipe(
        Effect.provideService(
          SshEnvironmentGateway,
          SshEnvironmentGateway.of({
            provision: () =>
              Effect.succeed({
                environmentId: EnvironmentId.make("environment-ssh"),
                label: "Remote development box",
                bootstrap: {
                  target,
                  httpBaseUrl: "http://127.0.0.1:3201",
                  wsBaseUrl: "ws://127.0.0.1:3201",
                  pairingToken: "pairing-token",
                },
                bearerToken: "bearer-token",
              }),
            prepare: () => Effect.die("unused"),
            disconnect: () => Effect.die("unused"),
          }),
        ),
      );

      expect(registration).toMatchObject({
        _tag: "SshConnectionRegistration",
        target: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: "ssh:environment-ssh",
        },
        profile: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: "ssh:environment-ssh",
          target,
        },
      });
    }),
  );
});
