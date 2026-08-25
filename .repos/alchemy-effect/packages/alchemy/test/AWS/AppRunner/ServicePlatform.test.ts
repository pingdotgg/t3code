import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as apprunner from "@distilled.cloud/aws/apprunner";
import * as ecr from "@distilled.cloud/aws/ecr";
import * as iam from "@distilled.cloud/aws/iam";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import TestService from "./fixtures/service.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Full end-to-end for the Effect-native `AppRunner.Service` form: bundle the
// inline Effect program, build + push the container image to the managed ECR
// repository (Docker build, linux/amd64), provision the instance/access IAM
// roles, and deploy the App Runner service — then prove over HTTPS that (a)
// the `{ fetch }` handler is served and (b) the `ServerHost.run` background
// loop is actually executing inside the deployed container (`/ticks` climbs).
//
// It is heavy (Docker build + ECR push + 3-5 min App Runner provisioning,
// bills while running), so it is gated behind AWS_TEST_SLOW=1 and always
// destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "deploys an Effect-native App Runner service and serves HTTP",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const service = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* TestService;
        }),
      );

      expect(service.serviceName).toBe("alchemy-test-apprunner-e2e");
      expect(service.status).toBe("RUNNING");
      expect(service.serviceUrl).toBeTruthy();
      // Effect-native attributes: managed repo, roles, and image.
      expect(service.repositoryUri).toBeTruthy();
      expect(service.imageUri).toBe(
        `${service.repositoryUri}:${service.codeHash}`,
      );
      expect(service.instanceRoleArn).toContain(":role/");
      expect(service.accessRoleArn).toContain(":role/");

      // Out-of-band verification via distilled: private ECR source wired to
      // the managed access role and instance role.
      const described = yield* apprunner.describeService({
        ServiceArn: service.serviceArn,
      });
      expect(
        described.Service.SourceConfiguration.ImageRepository
          ?.ImageRepositoryType,
      ).toBe("ECR");
      expect(
        described.Service.SourceConfiguration.AuthenticationConfiguration
          ?.AccessRoleArn,
      ).toBe(service.accessRoleArn);
      expect(described.Service.InstanceConfiguration.InstanceRoleArn).toBe(
        service.instanceRoleArn,
      );

      // The deployed program serves HTTP (ride out DNS/edge propagation).
      const health = yield* HttpClient.get(
        `https://${service.serviceUrl}/health`,
      ).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new Error(`/health returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("3 seconds"),
            Schedule.recurs(20),
          ]),
        }),
      );
      expect(health.status).toBe(200);

      // The `host.run` background loop is executing: /ticks climbs.
      const readTicks = HttpClient.get(
        `https://${service.serviceUrl}/ticks`,
      ).pipe(
        Effect.flatMap((res) => res.json),
        Effect.map((json) => (json as { ticks: number }).ticks),
      );
      const first = yield* readTicks;
      const later = yield* readTicks.pipe(
        Effect.flatMap((ticks) =>
          ticks > first
            ? Effect.succeed(ticks)
            : Effect.fail(new Error(`ticks not climbing (still ${ticks})`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(15),
          ]),
        }),
      );
      expect(later).toBeGreaterThan(first);

      // Destroy immediately — App Runner services bill while running — and
      // verify zero leftovers: service, managed repository, and both roles.
      const { repositoryName, instanceRoleName, accessRoleName, serviceArn } =
        service;
      yield* stack.destroy();

      const serviceAfter = yield* apprunner
        .describeService({ ServiceArn: serviceArn })
        .pipe(
          Effect.map((r) => (r.Service.Status ?? "UNKNOWN").toUpperCase()),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed("GONE" as const),
          ),
        );
      expect(["GONE", "DELETED"]).toContain(serviceAfter);

      const repoError = yield* Effect.flip(
        ecr.describeRepositories({ repositoryNames: [repositoryName!] }),
      );
      expect(repoError._tag).toBe("RepositoryNotFoundException");

      for (const roleName of [instanceRoleName!, accessRoleName!]) {
        const roleError = yield* Effect.flip(
          iam.getRole({ RoleName: roleName }),
        );
        expect(roleError._tag).toBe("NoSuchEntityException");
      }
    }),
  // Docker build + push (~2-4 min) + create (~3-5 min) + delete (~2-3 min).
  { timeout: 1_200_000 },
);
