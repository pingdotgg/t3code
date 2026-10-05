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

const waitUntilGone = (targetTcpProxyName: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getTargetTcpProxies({ project, targetTcpProxy: targetTcpProxyName })
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
  return parts[parts.length - 1] ?? "";
};

test.provider(
  "create, update, and delete a target tcp proxy",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const check = yield* GCP.Compute.HealthCheck("Probe", {
            description: "tcp probe",
            type: "TCP",
            tcpHealthCheck: { port: 80 },
          });
          const backend = yield* GCP.Compute.BackendService("TcpA", {
            protocol: "TCP",
            loadBalancingScheme: "EXTERNAL",
            description: "tcp backend a",
            healthChecks: [check.selfLink.as<string>()],
          });
          const proxy = yield* GCP.Compute.TargetTcpProxy("Proxy", {
            description: "tcp frontend",
            service: backend.name,
            proxyHeader: "NONE",
          });
          return { check, backend, proxy };
        }),
      );

      expect(created.proxy.targetTcpProxyName).toEqual(expect.any(String));
      expect(created.proxy.description).toEqual("tcp frontend");
      expect(
        created.proxy.proxyHeader === "NONE" ||
          created.proxy.proxyHeader === undefined,
      ).toEqual(true);
      expect(resourceTail(created.proxy.service)).toEqual(created.backend.name);

      const fetched = yield* compute.getTargetTcpProxies({
        project,
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
          const check = yield* GCP.Compute.HealthCheck("Probe", {
            healthCheckName: created.check.healthCheckName,
            description: "tcp probe",
            type: "TCP",
            tcpHealthCheck: { port: 80 },
          });
          yield* GCP.Compute.BackendService("TcpA", {
            name: created.backend.name,
            protocol: "TCP",
            loadBalancingScheme: "EXTERNAL",
            description: "tcp backend a",
            healthChecks: [check.selfLink.as<string>()],
          });
          const other = yield* GCP.Compute.BackendService("TcpB", {
            protocol: "TCP",
            loadBalancingScheme: "EXTERNAL",
            description: "tcp backend b",
            healthChecks: [check.selfLink.as<string>()],
          });
          const proxy = yield* GCP.Compute.TargetTcpProxy("Proxy", {
            targetTcpProxyName: created.proxy.targetTcpProxyName,
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

      const refetched = yield* compute.getTargetTcpProxies({
        project,
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

      const gone = yield* waitUntilGone(created.proxy.targetTcpProxyName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
