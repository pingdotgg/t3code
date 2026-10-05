import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as siteVerification from "@distilled.cloud/gcp/siteVerification_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Site Verification needs a credential with the siteverification OAuth
// scope (a Cloud Platform service-account token is rejected with
// InsufficientAuthenticationScopes) and a site whose verification token is
// already placed; set GCP_TEST_SITE_VERIFICATION=1 when both hold.
const runLifecycle =
  !process.env.FAST && process.env.GCP_TEST_SITE_VERIFICATION === "1";

const identifier = "https://alchemy-site-verification.test/";

const waitUntilGone = (webResourceId: string) =>
  siteVerification
    .getWebResource({
      id: decodeURIComponent(webResourceId),
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!runLifecycle)(
  "getWebResource on a missing site fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        siteVerification.getWebResource({
          id: "http://alchemy-missing.example.com/",
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:siteverification", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "getTokenWebResource without the siteverification scope fails with InsufficientAuthenticationScopes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        siteVerification.getTokenWebResource({
          body: {
            site: { identifier, type: "SITE" },
            verificationMethod: "FILE",
          },
        }),
      );
      expect(error._tag).toEqual("InsufficientAuthenticationScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:siteverification", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "insertWebResource without the siteverification scope fails with InsufficientAuthenticationScopes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        siteVerification.insertWebResource({
          verificationMethod: "FILE",
          body: { site: { identifier, type: "SITE" } },
        }),
      );
      expect(error._tag).toEqual("InsufficientAuthenticationScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:siteverification", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a web resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const resource = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SiteVerification.WebResource("Docs", {
            identifier,
            siteType: "SITE",
            verificationMethod: "FILE",
          });
        }),
      );
      expect(resource.webResourceId.length).toBeGreaterThan(0);
      expect(resource.identifier).toContain("alchemy-site-verification.test");
      expect(resource.siteType).toEqual("SITE");

      const fetched = yield* siteVerification.getWebResource({
        id: decodeURIComponent(resource.webResourceId),
      });
      expect(fetched.id).toEqual(resource.webResourceId);
      expect(fetched.site?.type).toEqual("SITE");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SiteVerification.WebResource("Docs", {
            identifier: resource.identifier,
            siteType: "SITE",
            owners: resource.owners,
          });
        }),
      );

      expect(updated.webResourceId).toEqual(resource.webResourceId);
      expect(updated.owners).toEqual(resource.owners);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(resource.webResourceId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:siteverification", "live"],
    timeout: 90_000,
  },
);
