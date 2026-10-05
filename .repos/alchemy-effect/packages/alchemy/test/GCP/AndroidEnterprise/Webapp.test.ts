import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as androidenterprise from "@distilled.cloud/gcp/androidenterprise_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  enterpriseId,
  logLevel,
  probeEnterpriseId,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (accountId: string, webAppId: string) =>
  androidenterprise.getWebapps({ enterpriseId: accountId, webAppId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!runLifecycle)(
  "getWebapps on a missing web app fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidenterprise.getWebapps({
          enterpriseId: probeEnterpriseId,
          webAppId: "app:com.google.enterprise.webapp.alchemy-missing",
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidenterprise", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "insertWebapps without the EMM OAuth scope fails with InsufficientAuthenticationScopes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidenterprise.insertWebapps({
          enterpriseId: probeEnterpriseId,
          body: {
            title: "Alchemy Probe Web App",
            startUrl: "https://example.com/",
            displayMode: "standalone",
          },
        }),
      );
      expect(error._tag).toEqual("InsufficientAuthenticationScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidenterprise", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a web app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AndroidEnterprise.Webapp("Portal", {
            enterpriseId: enterpriseId!,
            startUrl: "https://example.com/alchemy-portal",
            title: "Portal",
          });
        }),
      );

      expect(created.webAppId.length).toBeGreaterThan(0);
      expect(created.enterpriseId).toEqual(enterpriseId);
      expect(created.title).toEqual("Portal");
      expect(created.startUrl).toEqual("https://example.com/alchemy-portal");

      const fetched = yield* androidenterprise.getWebapps({
        enterpriseId: created.enterpriseId,
        webAppId: created.webAppId,
      });
      expect(fetched.webAppId).toEqual(created.webAppId);
      expect(fetched.title).toEqual("Portal");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AndroidEnterprise.Webapp("Portal", {
            enterpriseId: created.enterpriseId,
            webAppId: created.webAppId,
            startUrl: "https://example.com/alchemy-portal",
            title: "Employee portal",
          });
        }),
      );

      expect(updated.webAppId).toEqual(created.webAppId);
      expect(updated.title).toEqual("Employee portal");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.enterpriseId, created.webAppId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidenterprise", "live"],
    timeout: 90_000,
  },
);
