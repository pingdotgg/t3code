import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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

const waitUntilGone = (forwardingRuleName: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getGlobalForwardingRules({
          project,
          forwardingRule: forwardingRuleName,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (status) => status === "gone",
            times: 10,
          }),
        ),
    ),
  );

const resourceTail = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return (parts[parts.length - 1] ?? "").toLowerCase();
};

const httpsRedirect = (host: string) => ({
  httpsRedirect: true,
  hostRedirect: host,
  stripQuery: false,
});

test.provider(
  "create, update, and delete a global forwarding rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const map = yield* GCP.Compute.UrlMap("Web", {
            description: "https redirect",
            defaultUrlRedirect: httpsRedirect("example.com"),
          });
          const proxy = yield* GCP.Compute.TargetHttpProxy("Proxy", {
            description: "http frontend",
            urlMap: map.urlMapName,
          });
          return yield* GCP.Compute.GlobalForwardingRule("Http", {
            description: "alchemy test global forwarding rule",
            target: proxy.selfLink.as<string>(),
            portRange: "80",
            loadBalancingScheme: "EXTERNAL",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.forwardingRuleName).toEqual(expect.any(String));
      expect(created.ipAddress).toEqual(expect.any(String));
      expect(created.ipProtocol).toEqual("TCP");
      expect(created.loadBalancingScheme).toEqual("EXTERNAL");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.description).toEqual(
        "alchemy test global forwarding rule",
      );
      expect(resourceTail(created.target).length).toBeGreaterThan(0);

      const fetched = yield* compute.getGlobalForwardingRules({
        project: created.project,
        forwardingRule: created.forwardingRuleName,
      });
      expect(fetched.name).toEqual(created.forwardingRuleName);
      expect(fetched.IPAddress).toEqual(created.ipAddress);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain(
        "alchemy test global forwarding rule",
      );
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(resourceTail(fetched.target)).toEqual(
        resourceTail(created.target),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const map = yield* GCP.Compute.UrlMap("Web", {
            description: "https redirect",
            defaultUrlRedirect: httpsRedirect("example.com"),
          });
          const proxy = yield* GCP.Compute.TargetHttpProxy("Proxy", {
            description: "http frontend",
            urlMap: map.urlMapName,
          });
          return yield* GCP.Compute.GlobalForwardingRule("Http", {
            forwardingRuleName: created.forwardingRuleName,
            description: "alchemy test global forwarding rule",
            target: proxy.selfLink.as<string>(),
            portRange: "80",
            loadBalancingScheme: "EXTERNAL",
            labels: { env: "prod", role: "edge" },
          });
        }),
      );

      expect(updated.forwardingRuleName).toEqual(created.forwardingRuleName);
      expect(updated.ipAddress).toEqual(created.ipAddress);
      expect(updated.labels).toMatchObject({ env: "prod", role: "edge" });
      expect(resourceTail(updated.target)).toEqual(
        resourceTail(created.target),
      );

      const refetched = yield* compute.getGlobalForwardingRules({
        project: updated.project,
        forwardingRule: updated.forwardingRuleName,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("edge");
      expect(resourceTail(refetched.target)).toEqual(
        resourceTail(updated.target),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.forwardingRuleName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
