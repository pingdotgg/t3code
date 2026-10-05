import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
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
  recaptchaenterprise.getProjectsFirewallpolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// The firewall policy API is allow-listed per project. Set
// GCP_TEST_RECAPTCHA_FIREWALL=1 on a project with access.
const runFirewall = !!process.env.GCP_TEST_RECAPTCHA_FIREWALL;

test.provider.skipIf(runFirewall)(
  "listProjectsFirewallpolicies without API access fails with FirewallPolicyApiUnavailable",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        recaptchaenterprise.listProjectsFirewallpolicies({
          parent: `projects/${project}`,
        }),
      );
      expect(error._tag).toEqual("FirewallPolicyApiUnavailable");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:recaptchaenterprise", "live"],
    timeout: 60_000,
  },
);

test.provider.skipIf(!runFirewall)(
  "create, update, and delete a firewall policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.RecaptchaEnterprise.Firewallpolicy("Login", {
            path: "/login",
            description: "allow login",
            actions: [{ allow: {} }],
          });
        }),
      );

      expect(created.name).toContain("/firewallpolicies/");
      expect(created.firewallpolicyId).toEqual(expect.any(String));
      expect(created.path).toEqual("/login");
      expect(created.description).toEqual("allow login");
      expect(created.actions[0]?.allow).toEqual({});

      const fetched = yield* recaptchaenterprise.getProjectsFirewallpolicies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.path).toEqual("/login");
      expect(fetched.description).toEqual("allow login");
      expect(fetched.actions?.[0]?.allow).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.RecaptchaEnterprise.Firewallpolicy("Login", {
            firewallpolicyId: created.firewallpolicyId,
            path: "/signin",
            description: "allow sign-in",
            actions: [{ block: {} }],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.firewallpolicyId).toEqual(created.firewallpolicyId);
      expect(updated.path).toEqual("/signin");
      expect(updated.description).toEqual("allow sign-in");
      expect(updated.actions[0]?.block).toEqual({});

      const fetchedUpdate =
        yield* recaptchaenterprise.getProjectsFirewallpolicies({
          name: created.name,
        });
      expect(fetchedUpdate.path).toEqual("/signin");
      expect(fetchedUpdate.description).toEqual("allow sign-in");
      expect(fetchedUpdate.actions?.[0]?.block).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:recaptchaenterprise", "live"],
    timeout: 90_000,
  },
);
