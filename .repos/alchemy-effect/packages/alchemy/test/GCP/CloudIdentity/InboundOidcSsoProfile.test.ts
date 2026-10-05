import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudidentity from "@distilled.cloud/gcp/cloudidentity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { customer, logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  cloudidentity.getInboundOidcSsoProfiles({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getInboundOidcSsoProfiles on a missing profile fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudidentity.getInboundOidcSsoProfiles({
          name: "inboundOidcSsoProfiles/alchemy-missing",
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudidentity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.GCP_TEST_CLOUDIDENTITY)(
  "createInboundOidcSsoProfiles without Cloud Identity access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudidentity.createInboundOidcSsoProfiles({
          body: {
            customer,
            displayName: "Alchemy OIDC Probe",
            idpConfig: { issuerUri: "https://example.com" },
          },
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudidentity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an OIDC SSO profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudIdentity.InboundOidcSsoProfile("Okta", {
            customer,
            displayName: "Okta",
            idpConfig: { issuerUri: "https://idp.example.com" },
            rpConfig: { clientId: "google-rp", clientSecret: "secret" },
          });
        }),
      );

      expect(created.name.startsWith("inboundOidcSsoProfiles/")).toEqual(true);
      expect(created.displayName).toEqual("Okta");

      const fetched = yield* cloudidentity.getInboundOidcSsoProfiles({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudIdentity.InboundOidcSsoProfile("Okta", {
            customer,
            displayName: "Okta Prod",
            idpConfig: { issuerUri: "https://idp.example.com" },
            rpConfig: { clientId: "google-rp" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("Okta Prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudidentity", "live"],
    timeout: 90_000,
  },
);
