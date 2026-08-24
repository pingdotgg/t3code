import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as efs from "@distilled.cloud/aws/efs";
import { describe, expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { fileURLToPath } from "node:url";
import { getDefaultVpc } from "../DefaultVpc.ts";

// Flagship EFS e2e: a VPC-attached Lambda mounts an EFS access point at
// /mnt/test, writes a file over HTTP, reads it back, and a config redeploy
// (fresh sandboxes) proves the data outlives the execution environment.
//
// Uses the default VPC and its DEFAULT security group on purpose: the default
// group's self-referencing ingress rule allows the Lambda ENI to reach the
// mount target's NFS port, and because we never delete the default group we
// avoid waiting out the ~20-minute Hyperplane-ENI release that blocks
// deleting a security group that was attached to a Lambda.

const handlerPath = fileURLToPath(new URL("./efs-handler.ts", import.meta.url));

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "EFSLambdaMount");

let subnetId: string;
let securityGroupId: string;
let baseUrl: string;
let fileSystemId: string;

// Resolve the default VPC's subnet and default security group once. Runs
// inside a deploy effect (the `beforeAll` hook itself has no AWS context).
const resolveNetwork = Effect.gen(function* () {
  if (subnetId !== undefined) return;
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  subnetId = subnets.Subnets![0]!.SubnetId!;
  const groups = yield* EC2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "group-name", Values: ["default"] },
    ],
  });
  securityGroupId = groups.SecurityGroups![0]!.GroupId!;
});

const infra = (marker: string) =>
  Effect.gen(function* () {
    yield* resolveNetwork;
    const files = yield* AWS.EFS.FileSystem("MountFiles", {
      throughputMode: "elastic",
    });
    const target = yield* AWS.EFS.MountTarget("MountTarget", {
      fileSystemId: files.fileSystemId,
      subnetId,
    });
    const accessPoint = yield* AWS.EFS.AccessPoint("MountAccess", {
      fileSystemId: files.fileSystemId,
      posixUser: { uid: 1000, gid: 1000 },
      rootDirectory: {
        path: "/lambda",
        creationInfo: { ownerUid: 1000, ownerGid: 1000, permissions: "750" },
      },
    });
    const fn = yield* AWS.Lambda.Function("EfsFn", {
      main: handlerPath,
      handler: "handler",
      isExternal: true,
      url: true,
      memorySize: 256,
      timeout: Duration.seconds(30),
      vpc: { subnetIds: [subnetId], securityGroupIds: [securityGroupId] },
      fileSystemConfigs: [
        // pass the AccessPoint resource itself — the provider resolves its ARN
        { accessPoint, localMountPath: "/mnt/test" },
      ],
      env: {
        // Depend on the mount target so the function is only created once
        // the NFS endpoint is available (Lambda rejects a file-system config
        // whose mount targets are still creating).
        EFS_MOUNT_TARGET: target.mountTargetId,
        DEPLOY_MARKER: marker,
      },
    });
    return { files, target, accessPoint, fn };
  });

// VPC-attached Lambda cold starts ride on ENI/mount provisioning: budget a
// generous bounded retry for the FIRST request (3s × 60 ≈ 180s), then fail
// fast on later ones.
const getJsonWithRetry = (url: string, times: number) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new Error(`${url} returned ${response.status}: ${body}`),
              ),
            ),
          ),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(times),
      ]),
    }),
  );

// Gated behind AWS_TEST_SLOW: the suite's wall clock is ~6–8 minutes end to
// end — the beforeAll deploy alone is ~250s (file system + mount-target ENI
// provisioning + VPC-attached Lambda with EFS mount validation) and the
// afterAll teardown waits out the mount-target/ENI release (~2–4 min). That
// is genuinely slow platform provisioning, not a failure mode; the suite was
// verified green in wave 1C (commit e77b9fd83). Run with AWS_TEST_SLOW=1.
describe
  .skipIf(!process.env.AWS_TEST_SLOW)
  .sequential("EFS Lambda mount", () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();

        const deployed = yield* sharedStack.deploy(infra("first"));
        expect(deployed.fn.functionUrl).toBeTruthy();
        baseUrl = deployed.fn.functionUrl!.replace(/\/+$/, "");
        fileSystemId = deployed.files.fileSystemId;
      }),
      // The one slow deploy of the suite: file system (~15s) + mount target
      // (~90s, ENI provisioning) + VPC-attached Lambda (ENI + EFS mount
      // validation) — observed ~250s end to end.
      { timeout: 300_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 240_000 });

    test.provider(
      "writes and reads a file through the mount",
      () =>
        Effect.gen(function* () {
          // first request: rides through URL propagation + VPC/EFS cold start
          const mounted = (yield* getJsonWithRetry(`${baseUrl}/mount`, 60)) as {
            mounted: boolean;
          };
          expect(mounted.mounted).toBe(true);

          const written = (yield* getJsonWithRetry(
            `${baseUrl}/write?content=hello-from-efs`,
            5,
          )) as { written: string };
          expect(written.written).toBe("hello-from-efs");

          const read = (yield* getJsonWithRetry(`${baseUrl}/read`, 5)) as {
            content: string;
            marker: string;
          };
          expect(read.content).toBe("hello-from-efs");
          expect(read.marker).toBe("first");
        }),
      { timeout: 180_000 },
    );

    test.provider(
      "file persists across a redeploy (fresh sandboxes)",
      () =>
        Effect.gen(function* () {
          // config-only redeploy: new env marker forces an update, which spins
          // up fresh execution environments — the EFS file must survive.
          const redeployed = yield* sharedStack.deploy(infra("second"));
          expect(redeployed.files.fileSystemId).toBe(fileSystemId);

          // A drained-but-alive sandbox from the first deploy may briefly
          // answer with the old marker — poll until a fresh (marker=second)
          // environment serves the read.
          const read = yield* getJsonWithRetry(`${baseUrl}/read`, 10).pipe(
            Effect.map((r) => r as { content: string; marker: string }),
            Effect.repeat({
              schedule: Schedule.fixed("3 seconds"),
              until: (r) => r.marker === "second",
              times: 30,
            }),
          );
          expect(read.content).toBe("hello-from-efs");
          expect(read.marker).toBe("second");
        }),
      { timeout: 180_000 },
    );
  });
