import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as appengine from "@distilled.cloud/gcp/appengine_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Needs an App Engine application in the project, which is permanent once
// created (it can never be deleted). The testing project has none and the
// App Engine Admin API is off (ServiceDisabled: "App Engine Admin API has not been
// used in project ... or it is disabled."). Set GCP_TEST_APPENGINE_APP=1 on a
// project with an app to run the lifecycle.
const runLifecycle = !!process.env.GCP_TEST_APPENGINE_APP;

const waitUntilGone = (appsId: string, priority: number) =>
  appengine
    .getAppsFirewallIngressRules({
      appsId,
      ingressRulesId: String(priority),
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

test.provider(
  "getAppsFirewallIngressRules on a missing rule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        appengine.getAppsFirewallIngressRules({
          appsId: project,
          ingressRulesId: "999999998",
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:appengine", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "createAppsFirewallIngressRules without an App Engine app fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        appengine.createAppsFirewallIngressRules({
          appsId: project,
          body: {
            action: "DENY",
            sourceRange: "203.0.113.0/24",
            description: "Alchemy Appengine Probe",
            priority: 12345,
          },
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:appengine", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a firewall ingress rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AppEngine.AppsFirewallIngressRule("BlockOffice", {
            action: "DENY",
            sourceRange: "203.0.113.0/24",
            description: "office network",
          });
        }),
      );

      expect(created.priority).toBeGreaterThan(0);
      expect(created.action).toEqual("DENY");
      expect(created.sourceRange).toEqual("203.0.113.0/24");
      expect(created.description).toEqual("office network");

      const fetched = yield* appengine.getAppsFirewallIngressRules({
        appsId: created.appsId,
        ingressRulesId: String(created.priority),
      });
      expect(fetched.priority).toEqual(created.priority);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AppEngine.AppsFirewallIngressRule("BlockOffice", {
            priority: created.priority,
            action: "ALLOW",
            sourceRange: "203.0.113.0/24",
            description: "office network allow",
          });
        }),
      );

      expect(updated.priority).toEqual(created.priority);
      expect(updated.action).toEqual("ALLOW");
      expect(updated.description).toEqual("office network allow");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.appsId, created.priority);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:appengine", "live"], timeout: 90_000 },
);
