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

const waitUntilGone = (targetGrpcProxyName: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getTargetGrpcProxies({ project, targetGrpcProxy: targetGrpcProxyName })
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
  "create, update, and delete a target grpc proxy",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const backend = yield* GCP.Compute.BackendService("Grpc", {
            protocol: "GRPC",
            loadBalancingScheme: "INTERNAL_SELF_MANAGED",
            description: "grpc backend",
          });
          const map = yield* GCP.Compute.UrlMap("Map", {
            description: "grpc routes",
            defaultService: backend.selfLink,
          });
          return yield* GCP.Compute.TargetGrpcProxy("Proxy", {
            description: "grpc frontend",
            urlMap: map.urlMapName,
          });
        }),
      );

      expect(created.targetGrpcProxyName).toEqual(expect.any(String));
      expect(created.description).toEqual("grpc frontend");
      expect(created.validateForProxyless).toEqual(false);
      expect(resourceTail(created.urlMap).length).toBeGreaterThan(0);

      const fetched = yield* compute.getTargetGrpcProxies({
        project,
        targetGrpcProxy: created.targetGrpcProxyName,
      });
      expect(fetched.name).toEqual(created.targetGrpcProxyName);
      expect(resourceTail(fetched.urlMap)).toEqual(
        resourceTail(created.urlMap),
      );
      expect(fetched.validateForProxyless).toEqual(false);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("grpc frontend");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const backend = yield* GCP.Compute.BackendService("Grpc", {
            protocol: "GRPC",
            loadBalancingScheme: "INTERNAL_SELF_MANAGED",
            description: "grpc backend",
          });
          const map = yield* GCP.Compute.UrlMap("Map", {
            description: "grpc routes",
            defaultService: backend.selfLink,
          });
          return yield* GCP.Compute.TargetGrpcProxy("Proxy", {
            targetGrpcProxyName: created.targetGrpcProxyName,
            description: "updated frontend",
            urlMap: map.urlMapName,
          });
        }),
      );

      expect(updated.targetGrpcProxyName).toEqual(created.targetGrpcProxyName);
      expect(updated.description).toEqual("updated frontend");
      expect(resourceTail(updated.urlMap)).toEqual(
        resourceTail(created.urlMap),
      );

      const refetched = yield* compute.getTargetGrpcProxies({
        project,
        targetGrpcProxy: updated.targetGrpcProxyName,
      });
      expect(refetched.description).toContain("updated frontend");
      expect(resourceTail(refetched.urlMap)).toEqual(
        resourceTail(updated.urlMap),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.targetGrpcProxyName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);
