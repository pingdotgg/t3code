import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import { Task } from "@/AWS/ECS/Task.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { reclaimTaskDefinitionFamily } from "./reclaimTaskDefinitionFamily.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Deploying a full `Task` requires a Docker build + ECR push, which is far too
// heavy for a `list()` test. Instead we register a task definition out-of-band
// in the exact shape the provider produces (single container whose image is an
// ECR `<repoUri>:<hash>`, task/execution role ARNs, an awslogs log group), then
// assert `list()` reconstructs the full Attributes and includes it, and finally
// deregister it. This live-verifies the listTaskDefinitions -> describe ->
// Attributes reconstruction path without the container build overhead.
test.provider(
  "list enumerates registered task definitions",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;

      const family = "alchemy-test-ecs-task-list";
      const repositoryName = "alchemy-test-ecs-task-list-repo";
      const repositoryUri = `${accountId}.dkr.ecr.${region}.amazonaws.com/${repositoryName}`;
      const hash = "listtest";
      const imageUri = `${repositoryUri}:${hash}`;
      const logGroupName = "/alchemy/test/ecs-task-list";
      const taskRoleName = "alchemy-test-ecs-task-list-task-role";
      const executionRoleName = "alchemy-test-ecs-task-list-execution-role";

      // Reclaim any revisions a previously-killed run left behind, and
      // guarantee full deletion (deregister + delete) on success, failure,
      // and interruption.
      yield* reclaimTaskDefinitionFamily(family);
      yield* Effect.addFinalizer(() =>
        reclaimTaskDefinitionFamily(family).pipe(Effect.ignore),
      );

      const registered = yield* ecs.registerTaskDefinition({
        family,
        taskRoleArn: `arn:aws:iam::${accountId}:role/${taskRoleName}`,
        executionRoleArn: `arn:aws:iam::${accountId}:role/${executionRoleName}`,
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: "256",
        memory: "512",
        containerDefinitions: [
          {
            name: family,
            image: imageUri,
            essential: true,
            portMappings: [
              { containerPort: 3000, hostPort: 3000, protocol: "tcp" },
            ],
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": logGroupName,
                "awslogs-region": region,
                "awslogs-stream-prefix": family,
              },
            },
          },
        ],
      });
      const arn = registered.taskDefinition?.taskDefinitionArn;
      expect(arn).toBeDefined();

      const provider = yield* Provider.findProvider(Task);
      const all = yield* provider.list();

      const found = all.find((t) => t.taskDefinitionArn === arn);
      expect(found).toBeDefined();
      expect(found?.taskFamily).toBe(family);
      expect(found?.containerName).toBe(family);
      expect(found?.port).toBe(3000);
      expect(found?.imageUri).toBe(imageUri);
      expect(found?.repositoryName).toBe(repositoryName);
      expect(found?.repositoryUri).toBe(repositoryUri);
      expect(found?.code.hash).toBe(hash);
      expect(found?.logGroupName).toBe(logGroupName);
      expect(found?.logGroupArn).toBe(
        `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}`,
      );
      expect(found?.taskRoleName).toBe(taskRoleName);
      expect(found?.executionRoleName).toBe(executionRoleName);

      yield* reclaimTaskDefinitionFamily(family);
    }),
  { timeout: 240_000 },
);

// Multi-container + task-level props round-trip. Registering a task definition
// is cheap (no Docker build), so we exercise the full typed surface
// out-of-band: a 2-container task (app + sidecar with dependsOn/portMappings/
// logConfiguration), task-level ephemeralStorage, runtimePlatform (ARM64), and
// an EFS-less host volume, then describe it back and assert the shapes
// survived, then deregister. This validates that the distilled
// registerTaskDefinition surface we wire in `Task` is correct.
test.provider(
  "multi-container task definition round-trips task-level props",
  () =>
    Effect.gen(function* () {
      const family = "alchemy-test-ecs-task-multicontainer";

      // Reclaim any revisions a previously-killed run left behind, and
      // guarantee full deletion of BOTH revisions registered below on
      // success, failure, and interruption.
      yield* reclaimTaskDefinitionFamily(family);
      yield* Effect.addFinalizer(() =>
        reclaimTaskDefinitionFamily(family).pipe(Effect.ignore),
      );

      const registered = yield* ecs.registerTaskDefinition({
        family,
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: "256",
        memory: "512",
        runtimePlatform: {
          cpuArchitecture: "ARM64",
          operatingSystemFamily: "LINUX",
        },
        ephemeralStorage: { sizeInGiB: 25 },
        volumes: [{ name: "scratch", host: {} }],
        containerDefinitions: [
          {
            name: "app",
            image: "public.ecr.aws/nginx/nginx:stable",
            essential: true,
            portMappings: [{ containerPort: 80, protocol: "tcp" }],
            mountPoints: [
              { sourceVolume: "scratch", containerPath: "/scratch" },
            ],
            dependsOn: [{ containerName: "sidecar", condition: "START" }],
          },
          {
            name: "sidecar",
            image: "public.ecr.aws/docker/library/busybox:latest",
            essential: false,
            command: ["sh", "-c", "while true; do sleep 30; done"],
          },
        ],
      });
      const td = registered.taskDefinition;
      const arn = td?.taskDefinitionArn;
      expect(arn).toBeDefined();

      const described = yield* ecs.describeTaskDefinition({
        taskDefinition: arn!,
      });
      const def = described.taskDefinition;
      expect(def?.containerDefinitions?.length).toBe(2);
      expect(def?.containerDefinitions?.map((c) => c.name)).toEqual([
        "app",
        "sidecar",
      ]);
      expect(
        def?.containerDefinitions?.[0]?.dependsOn?.[0]?.containerName,
      ).toBe("sidecar");
      expect(def?.runtimePlatform?.cpuArchitecture).toBe("ARM64");
      expect(def?.ephemeralStorage?.sizeInGiB).toBe(25);
      expect(def?.volumes?.[0]?.name).toBe("scratch");

      // Update one container (new image) → new revision number.
      const updated = yield* ecs.registerTaskDefinition({
        family,
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: "256",
        memory: "512",
        containerDefinitions: [
          {
            name: "app",
            image: "public.ecr.aws/nginx/nginx:latest",
            essential: true,
            portMappings: [{ containerPort: 80, protocol: "tcp" }],
          },
        ],
      });
      expect(updated.taskDefinition?.revision).toBeGreaterThan(td!.revision!);

      yield* reclaimTaskDefinitionFamily(family);
    }),
  { timeout: 120_000 },
);

// Revision hygiene: every reconcile registers a NEW task-definition
// revision, so the superseded revision must be reaped (deregistered + hard
// deleted) on the spot, and destroy must sweep every remaining revision of
// the family. Uses the registry-image form (`image:` mirrored into ECR via a
// local docker pull/tag/push of a tiny busybox) — no Fargate placement, no
// bundling. Requires a local Docker daemon (same as the Service platform
// tests).
test.provider(
  "superseded task-definition revisions are reaped on reconcile and destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (marker: string) =>
        Effect.gen(function* () {
          return yield* Task("RevisionReapTask", {
            // Docker Hub busybox: the public.ecr.aws mirror aggressively
            // rate-limits anonymous pulls during local builds.
            image: "busybox:stable",
            command: ["sh", "-c", "true"],
            cpu: 256,
            memory: 512,
            env: { MARKER: marker },
          });
        });

      const deployed = yield* stack.deploy(program("one"));
      expect(deployed.taskDefinitionArn).toBeTruthy();

      // Redeploy with a changed env var → a new revision in the same family.
      const redeployed = yield* stack.deploy(program("two"));
      expect(redeployed.taskFamily).toBe(deployed.taskFamily);
      expect(redeployed.taskDefinitionArn).not.toBe(deployed.taskDefinitionArn);

      const newRevision = yield* ecs.describeTaskDefinition({
        taskDefinition: redeployed.taskDefinitionArn,
      });
      expect(newRevision.taskDefinition?.status).toBe("ACTIVE");
      expect(
        newRevision.taskDefinition?.containerDefinitions?.[0]?.environment?.find(
          (e) => e.name === "MARKER",
        )?.value,
      ).toBe("two");

      // The superseded revision was reaped by the redeploy, not left ACTIVE.
      const supersededReaped = yield* ecs
        .describeTaskDefinition({
          taskDefinition: deployed.taskDefinitionArn,
        })
        .pipe(
          Effect.map((r) => r.taskDefinition?.status !== "ACTIVE"),
          Effect.catchTag("ClientException", () => Effect.succeed(true)),
        );
      expect(supersededReaped).toBe(true);

      yield* stack.destroy();

      // Zero-orphan proof: no revision of the family survives destroy as
      // ACTIVE.
      const activeRevisions = yield* ecs
        .listTaskDefinitions({
          familyPrefix: deployed.taskFamily,
          status: "ACTIVE",
        })
        .pipe(
          Effect.map((r) =>
            (r.taskDefinitionArns ?? []).filter((arn) =>
              arn.includes(`/${deployed.taskFamily}:`),
            ),
          ),
        );
      expect(activeRevisions).toEqual([]);
    }),
  { timeout: 240_000 },
);
