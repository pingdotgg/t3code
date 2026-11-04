import * as AWS from "@alchemy.run/aws";
import { runsAsGoogleServiceAccount, runsAsRole } from "@alchemy.run/aws/AWSBindings";
import * as GCP from "@alchemy.run/gcp";
import { describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as iam from "@distilled.cloud/aws/iam";
import * as sqs from "@distilled.cloud/aws/sqs";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import type { ResourceLike } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type { ProbeOutcome } from "../GCP/bindingHost.ts";
import FederatedHost, { Jobs } from "./fixtures/gcp-host.ts";

const host = (Type: string, Props?: object) =>
  ({ Type, LogicalId: "Host", FQN: "Host", Props }) as ResourceLike;

describe("AWSBindings.runsAsRole", { tags: ["unit", "provider:aws", "local"] }, () => {
  it("accepts Lambda, ECS and EC2", () => {
    for (const Type of ["AWS.Lambda.Function", "AWS.ECS.Task", "AWS.EC2.Instance"]) {
      expect(runsAsRole(host(Type))).toBe(true);
    }
  });

  it("accepts Kubernetes workloads on EKS (Pod Identity)", () => {
    const eks = { Type: "AWS.EKS.Cluster", LogicalId: "Cluster" };
    expect(runsAsRole(host("Kubernetes.Deployment", { cluster: eks }))).toBe(true);
    expect(
      runsAsRole(
        host("Kubernetes.Job", { cluster: { auth: { kind: "aws-eks", clusterName: "c" } } }),
      ),
    ).toBe(true);
    expect(
      runsAsRole(
        host("Kubernetes.Job", {
          cluster: { connection: { auth: { kind: "aws-eks", clusterName: "c" } } },
        }),
      ),
    ).toBe(true);
  });

  it("accepts a Kubernetes workload on an EKS cluster ref", () =>
    Effect.gen(function* () {
      const cluster = yield* AWS.EKS.Cluster.ref("Cluster");
      expect(runsAsRole(host("Kubernetes.Deployment", { cluster }))).toBe(true);
    }).pipe(Effect.runSync));

  it("rejects Kubernetes workloads on other clusters", () => {
    const gke = { Type: "GCP.Container.Cluster", LogicalId: "Cluster" };
    const local = { Type: "Kubernetes.LocalCluster", LogicalId: "Cluster" };
    const kubeconfig = { auth: { kind: "kubeconfig", context: "prod" } };
    for (const cluster of [gke, local, kubeconfig, undefined]) {
      expect(runsAsRole(host("Kubernetes.Deployment", { cluster }))).toBe(false);
    }
  });

  it("rejects AWS resources that run no code as a role", () => {
    expect(runsAsRole(host("AWS.S3.Bucket"))).toBe(false);
    // A MicroVM image has no role of its own; RunMicrovm takes one per launch.
    expect(runsAsRole(host("AWS.Lambda.MicrovmImage"))).toBe(false);
  });

  it("rejects hosts outside AWS", () => {
    expect(runsAsRole(host("Neon.Function"))).toBe(false);
    expect(runsAsRole(host("Cloudflare.Worker"))).toBe(false);
  });
});

describe(
  "AWSBindings.runsAsGoogleServiceAccount",
  { tags: ["unit", "provider:aws", "local"] },
  () => {
    it("accepts Cloud Run and Cloud Functions", () => {
      for (const Type of [
        "GCP.Run.Service",
        "GCP.Run.Job",
        "GCP.Run.WorkerPool",
        "GCP.CloudFunctions.Function",
      ]) {
        expect(runsAsGoogleServiceAccount(host(Type))).toBe(true);
      }
    });

    it("rejects GKE pods, which have no Google ID tokens", () => {
      const gke = { Type: "GCP.Container.Cluster", LogicalId: "Cluster" };
      expect(runsAsGoogleServiceAccount(host("Kubernetes.Deployment", { cluster: gke }))).toBe(
        false,
      );
    });

    it("rejects AWS and other hosts", () => {
      expect(runsAsGoogleServiceAccount(host("AWS.Lambda.Function"))).toBe(false);
      expect(runsAsGoogleServiceAccount(host("Cloudflare.Worker"))).toBe(false);
    });
  },
);

const { test: liveTest } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), GCP.providers()),
});

class SendNotReady extends Data.TaggedError("SendNotReady")<{ reason: string }> {}

describe(
  "AWS bindings on a Google service account host",
  { tags: ["provider:aws", "provider:gcp", "provider:gcp:run", "live"] },
  () => {
    liveTest.provider(
      "Cloud Run reaches SQS by assuming a Role with its Google ID token",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const out = yield* stack.deploy(
            Effect.gen(function* () {
              const host = yield* FederatedHost;
              const jobs = yield* Jobs;
              return {
                uri: host.uri,
                name: host.name,
                uniqueId: host.serviceAccountUniqueId,
                queueUrl: jobs.queueUrl,
              };
            }),
          );
          expect(out.uniqueId).toMatch(/^\d+$/);

          // The host has no AWS key, only the Role it assumes.
          const service = yield* cloudrun.getProjectsLocationsServices({ name: out.name });
          const env = Object.fromEntries(
            (service.template?.containers?.[0]?.env ?? []).map((entry) => [
              entry.name,
              entry.value,
            ]),
          );
          expect(env.ALCHEMY_AWS_ACCESS_KEY_ID).toBeUndefined();
          expect(env.ALCHEMY_AWS_SECRET_ACCESS_KEY).toBeUndefined();
          const roleArn = env.ALCHEMY_AWS_WEB_IDENTITY_ROLE_ARN;
          expect(roleArn).toMatch(/^arn:aws:iam::\d{12}:role\//);
          const roleName = roleArn!.split("/").pop()!;

          const role = yield* iam.getRole({ RoleName: roleName });
          const trust = JSON.parse(decodeURIComponent(role.Role.AssumeRolePolicyDocument!)) as {
            Statement: Array<Record<string, any>>;
          };
          expect(trust.Statement).toEqual([
            expect.objectContaining({
              Effect: "Allow",
              Principal: { Federated: "accounts.google.com" },
              Action: "sts:AssumeRoleWithWebIdentity",
              Condition: {
                StringEquals: {
                  "accounts.google.com:sub": out.uniqueId,
                  "accounts.google.com:aud": out.uniqueId,
                  "accounts.google.com:oaud": "sts.amazonaws.com",
                },
              },
            }),
          ]);

          // A new role's trust takes a while to propagate to STS.
          const sent = yield* HttpClient.get(`${out.uri!.replace(/\/+$/, "")}/probe/send`).pipe(
            Effect.flatMap((response) =>
              response.status === 200
                ? (response.json as Effect.Effect<ProbeOutcome<{ MessageId?: string }>>)
                : Effect.fail(new SendNotReady({ reason: `HTTP ${response.status}` })),
            ),
            Effect.flatMap((outcome) =>
              outcome.ok
                ? Effect.succeed(outcome.value)
                : Effect.fail(
                    new SendNotReady({
                      reason: `${outcome.error._tag}: ${outcome.error.message ?? ""}`,
                    }),
                  ),
            ),
            Effect.mapError((error) =>
              error._tag === "SendNotReady" ? error : new SendNotReady({ reason: String(error) }),
            ),
            Effect.tapError((error) => Effect.logInfo(`send not ready: ${error.reason}`)),
            Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          );
          expect(sent.MessageId).toBeDefined();

          const received = yield* sqs
            .receiveMessage({
              QueueUrl: out.queueUrl,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 10,
            })
            .pipe(
              Effect.repeat({
                until: (response) => (response.Messages ?? []).length > 0,
                times: 6,
              }),
            );
          expect(received.Messages?.[0]?.Body).toBe("hello from cloud run");

          yield* stack.destroy();

          const gone = yield* iam.getRole({ RoleName: roleName }).pipe(
            Effect.as(false),
            Effect.catchTag("NoSuchEntityException", () => Effect.succeed(true)),
          );
          expect(gone).toBe(true);
        }),
      { timeout: 900_000 },
    );
  },
);
