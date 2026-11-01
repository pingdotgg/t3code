import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as recaptchaenterprise from "@distilled.cloud/gcp/recaptchaenterprise_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  recaptchaenterprise.getProjectsKeys({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a reCAPTCHA key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.RecaptchaEnterprise.Key("Signup", {
            displayName: "alchemy recaptcha signup",
            labels: { env: "test" },
            testingOptions: { testingScore: 0.9 },
            webSettings: {
              integrationType: "SCORE",
              allowAllDomains: true,
            },
          });
        }),
      );

      expect(created.name).toContain("/keys/");
      expect(created.keyId).toEqual(expect.any(String));
      expect(created.displayName).toEqual("alchemy recaptcha signup");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.webSettings?.integrationType).toEqual("SCORE");
      expect(created.testingOptions?.testingScore).toEqual(0.9);

      const fetched = yield* recaptchaenterprise.getProjectsKeys({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("alchemy recaptcha signup");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.webSettings?.integrationType).toEqual("SCORE");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.RecaptchaEnterprise.Key("Signup", {
            keyId: created.keyId,
            displayName: "alchemy recaptcha signup v2",
            labels: { env: "prod", role: "bot" },
            testingOptions: { testingScore: 0.9 },
            webSettings: {
              integrationType: "SCORE",
              allowAllDomains: true,
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.keyId).toEqual(created.keyId);
      expect(updated.displayName).toEqual("alchemy recaptcha signup v2");
      expect(updated.labels).toMatchObject({ env: "prod", role: "bot" });
      expect(updated.testingOptions?.testingScore).toEqual(0.9);

      const fetchedUpdate = yield* recaptchaenterprise.getProjectsKeys({
        name: created.name,
      });
      expect(fetchedUpdate.displayName).toEqual("alchemy recaptcha signup v2");
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("bot");
      expect(fetchedUpdate.labels?.["alchemy-id"]).toEqual(expect.any(String));

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:recaptchaenterprise", "live"],
    timeout: 90_000,
  },
);
