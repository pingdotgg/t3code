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

const region = "us-central1";

const waitUntilGone = (project: string, targetTcpProxyName: string) =>
  compute
    .getRegionTargetTcpProxies({
      project,
      region,
      targetTcpProxy: targetTcpProxyName,
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

const resourceTail = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
};

test.provider(
  "getRegionTargetTcpProxies on a missing proxy fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        compute.getRegionTargetTcpProxies({
          project,
          region,
          targetTcpProxy: "alchemy-missing-rtcp",
        }),
      );
      expect(error._tag).toBe("NotFound");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a regional target tcp proxy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const check = yield* GCP.Compute.RegionHealthCheck("Probe", {
            region,
            description: "tcp probe",
            type: "TCP",
            tcpHealthCheck: { port: 80 },
          });
          const backend = yield* GCP.Compute.RegionBackendService("TcpA", {
            region,
            protocol: "TCP",
            loadBalancingScheme: "INTERNAL_MANAGED",
            description: "tcp backend a",
            healthChecks: [check.selfLink.as<string>()],
          });
          const proxy = yield* GCP.Compute.RegionTargetTcpProxy("Proxy", {
            region,
            description: "tcp frontend",
            service: backend.name,
            proxyHeader: "NONE",
          });
          return { check, backend, proxy };
        }),
      );

      expect(created.proxy.targetTcpProxyName).toEqual(expect.any(String));
      expect(created.proxy.region).toEqual(region);
      expect(created.proxy.description).toEqual("tcp frontend");
      expect(
        created.proxy.proxyHeader === "NONE" ||
          created.proxy.proxyHeader === undefined,
      ).toEqual(true);
      expect(resourceTail(created.proxy.service)).toEqual(created.backend.name);

      const fetched = yield* compute.getRegionTargetTcpProxies({
        project: created.proxy.project,
        region,
        targetTcpProxy: created.proxy.targetTcpProxyName,
      });
      expect(fetched.name).toEqual(created.proxy.targetTcpProxyName);
      expect(resourceTail(fetched.service)).toEqual(
        resourceTail(created.proxy.service),
      );
      expect(fetched.proxyHeader ?? "NONE").toEqual("NONE");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("tcp frontend");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const check = yield* GCP.Compute.RegionHealthCheck("Probe", {
            healthCheckName: created.check.healthCheckName,
            region,
            description: "tcp probe",
            type: "TCP",
            tcpHealthCheck: { port: 80 },
          });
          yield* GCP.Compute.RegionBackendService("TcpA", {
            name: created.backend.name,
            region,
            protocol: "TCP",
            loadBalancingScheme: "INTERNAL_MANAGED",
            description: "tcp backend a",
            healthChecks: [check.selfLink.as<string>()],
          });
          const other = yield* GCP.Compute.RegionBackendService("TcpB", {
            region,
            protocol: "TCP",
            loadBalancingScheme: "INTERNAL_MANAGED",
            description: "tcp backend b",
            healthChecks: [check.selfLink.as<string>()],
          });
          const proxy = yield* GCP.Compute.RegionTargetTcpProxy("Proxy", {
            targetTcpProxyName: created.proxy.targetTcpProxyName,
            region,
            description: "tcp frontend",
            service: other.name,
            proxyHeader: "PROXY_V1",
          });
          return { other, proxy };
        }),
      );

      expect(updated.proxy.targetTcpProxyName).toEqual(
        created.proxy.targetTcpProxyName,
      );
      expect(updated.proxy.description).toEqual("tcp frontend");
      expect(updated.proxy.proxyHeader).toEqual("PROXY_V1");
      expect(resourceTail(updated.proxy.service)).toEqual(updated.other.name);

      const refetched = yield* compute.getRegionTargetTcpProxies({
        project: updated.proxy.project,
        region,
        targetTcpProxy: updated.proxy.targetTcpProxyName,
      });
      expect(refetched.proxyHeader).toEqual("PROXY_V1");
      expect(resourceTail(refetched.service)).toEqual(
        resourceTail(updated.proxy.service),
      );
      expect(resourceTail(refetched.service)).not.toEqual(
        resourceTail(created.proxy.service),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.proxy.project,
        created.proxy.targetTcpProxyName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
