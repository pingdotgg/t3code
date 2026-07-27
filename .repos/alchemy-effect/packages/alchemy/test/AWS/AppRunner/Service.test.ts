import * as AWS from "@/AWS";
import { AutoScalingConfiguration, Service } from "@/AWS/AppRunner";
import * as Test from "@/Test/Alchemy";
import * as apprunner from "@distilled.cloud/aws/apprunner";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag the provider's observe/read/delete paths depend on.
test.provider(
  "describeService on a nonexistent ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { Account } = yield* sts.getCallerIdentity({});
      const error = yield* Effect.flip(
        apprunner.describeService({
          ServiceArn: `arn:aws:apprunner:us-west-2:${Account}:service/alchemy-nonexistent-probe/0000000000000000000000000000000000`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// The provider's delete already waits until the service is gone, so this
// asserts DELETED-or-gone with a short bounded confirmation retry.
const assertServiceGone = (arn: string) =>
  Effect.gen(function* () {
    const status = yield* apprunner.describeService({ ServiceArn: arn }).pipe(
      Effect.map((r) => (r.Service.Status ?? "UNKNOWN").toUpperCase()),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("GONE" as const),
      ),
    );
    if (status !== "GONE" && status !== "DELETED") {
      return yield* Effect.fail(
        new Error(`App Runner service still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(12),
      ]),
    }),
  );

const assertConfigGone = (name: string) =>
  Effect.gen(function* () {
    const page = yield* apprunner.listAutoScalingConfigurations({
      AutoScalingConfigurationName: name,
    });
    const active = (page.AutoScalingConfigurationSummaryList ?? []).filter(
      (s) =>
        s.AutoScalingConfigurationName === name &&
        s.Status?.toUpperCase() === "ACTIVE",
    );
    if (active.length > 0) {
      return yield* Effect.fail(
        new Error(
          `Auto scaling configuration '${name}' still has ACTIVE revisions`,
        ),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(12),
      ]),
    }),
  );

// App Runner service provisioning takes 3-5+ minutes and the service bills
// while it runs, so the full lifecycle is gated behind AWS_TEST_SLOW=1 and
// always destroys what it created. The source is a public ECR gallery
// image (ECR_PUBLIC), which needs no access role, no local Docker build,
// and no private repository.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create a public-ECR service with custom scaling, verify it serves, destroy, verify gone",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const { asc, service } = yield* stack.deploy(
        Effect.gen(function* () {
          const asc = yield* AutoScalingConfiguration("SvcScaling", {
            autoScalingConfigurationName: "alchemy-test-svc-asc",
            maxConcurrency: 100,
            minSize: 1,
            maxSize: 1,
          });
          const service = yield* Service("HelloService", {
            serviceName: "alchemy-test-apprunner-svc",
            imageRepository: {
              imageIdentifier:
                "public.ecr.aws/aws-containers/hello-app-runner:latest",
              imageRepositoryType: "ECR_PUBLIC",
              port: "8000",
            },
            autoDeploymentsEnabled: false,
            instanceConfiguration: { cpu: "256", memory: "512" },
            autoScalingConfigurationArn: asc.autoScalingConfigurationArn,
          });
          return { asc, service };
        }),
      );

      expect(service.serviceName).toBe("alchemy-test-apprunner-svc");
      expect(service.serviceArn).toContain(
        ":service/alchemy-test-apprunner-svc/",
      );
      expect(service.status).toBe("RUNNING");
      expect(service.serviceUrl).toBeDefined();

      // Out-of-band verification via distilled: RUNNING, wired to the
      // custom auto scaling configuration, right image + instance size.
      const described = yield* apprunner.describeService({
        ServiceArn: service.serviceArn,
      });
      expect(described.Service.Status).toBe("RUNNING");
      expect(
        described.Service.AutoScalingConfigurationSummary
          ?.AutoScalingConfigurationArn,
      ).toBe(asc.autoScalingConfigurationArn);
      expect(
        described.Service.SourceConfiguration.ImageRepository
          ?.ImageRepositoryType,
      ).toBe("ECR_PUBLIC");
      expect(described.Service.InstanceConfiguration.Cpu).toBe("256");
      expect(described.Service.InstanceConfiguration.Memory).toBe("512");

      // The public endpoint serves. The URL is live once RUNNING, but ride
      // out DNS/edge propagation with a bounded retry.
      const response = yield* HttpClient.get(
        `https://${service.serviceUrl}`,
      ).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new Error(`service returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("3 seconds"),
            Schedule.recurs(20),
          ]),
        }),
      );
      expect(response.status).toBe(200);

      // Destroy immediately — App Runner services bill while running —
      // and verify both the service and its scaling config are gone.
      yield* stack.destroy();
      yield* assertServiceGone(service.serviceArn);
      yield* assertConfigGone("alchemy-test-svc-asc");
    }),
  // create (~3-5 min) + delete (~2-3 min), one sequential test.
  { timeout: 900_000 },
);
