import * as AWS from "@alchemy.run/aws";
import * as GCP from "@alchemy.run/gcp";
import { runsAsAwsRole, runsAsServiceAccount } from "@alchemy.run/gcp/GCPBindings";
import { describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import type { ResourceLike } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import FederatedLambdaLive, { Events, FederatedLambda } from "./fixtures/aws-host.ts";

const host = (Type: string, Props?: object) =>
  ({ Type, LogicalId: "Host", FQN: "Host", Props }) as ResourceLike;

describe("GCPBindings.runsAsServiceAccount", { tags: ["unit", "provider:gcp", "local"] }, () => {
  it("accepts Cloud Run and Cloud Functions", () => {
    for (const Type of [
      "GCP.Run.Service",
      "GCP.Run.Job",
      "GCP.Run.WorkerPool",
      "GCP.CloudFunctions.Function",
    ]) {
      expect(runsAsServiceAccount(host(Type))).toBe(true);
    }
  });

  it("accepts Kubernetes workloads on GKE (Workload Identity)", () => {
    const gke = { Type: "GCP.Container.Cluster", LogicalId: "Cluster" };
    expect(runsAsServiceAccount(host("Kubernetes.Deployment", { cluster: gke }))).toBe(true);
    expect(
      runsAsServiceAccount(
        host("Kubernetes.Job", { cluster: { auth: { kind: "gcp-gke", cluster: "c" } } }),
      ),
    ).toBe(true);
    expect(
      runsAsServiceAccount(
        host("Kubernetes.Job", {
          cluster: { connection: { auth: { kind: "gcp-gke", cluster: "c" } } },
        }),
      ),
    ).toBe(true);
  });

  it("accepts a Kubernetes workload on a GKE cluster ref", () =>
    Effect.gen(function* () {
      const cluster = yield* GCP.Container.Cluster.ref("Cluster");
      expect(runsAsServiceAccount(host("Kubernetes.Deployment", { cluster }))).toBe(true);
    }).pipe(Effect.runSync));

  it("rejects Kubernetes workloads on other clusters", () => {
    const eks = { Type: "AWS.EKS.Cluster", LogicalId: "Cluster" };
    const local = { Type: "Kubernetes.LocalCluster", LogicalId: "Cluster" };
    const kubeconfig = { auth: { kind: "kubeconfig", context: "prod" } };
    for (const cluster of [eks, local, kubeconfig, undefined]) {
      expect(runsAsServiceAccount(host("Kubernetes.Deployment", { cluster }))).toBe(false);
    }
  });

  it("rejects hosts outside GCP and GCP resources that run no code", () => {
    expect(runsAsServiceAccount(host("Cloudflare.Worker"))).toBe(false);
    expect(runsAsServiceAccount(host("AWS.Lambda.Function"))).toBe(false);
    expect(runsAsServiceAccount(host("GCP.Storage.Bucket"))).toBe(false);
  });
});

describe("GCPBindings.runsAsAwsRole", { tags: ["unit", "provider:gcp", "local"] }, () => {
  it("accepts Lambda, ECS, EC2 and App Runner", () => {
    for (const Type of [
      "AWS.Lambda.Function",
      "AWS.Lambda.WebFunction",
      "AWS.ECS.Task",
      "AWS.ECS.Service",
      "AWS.EC2.Instance",
      "AWS.AutoScaling.LaunchTemplate",
      "AWS.AppRunner.Service",
    ]) {
      expect(runsAsAwsRole(host(Type))).toBe(true);
    }
  });

  it("rejects EKS pods and Batch jobs, which keep a key", () => {
    const eks = { Type: "AWS.EKS.Cluster", LogicalId: "Cluster" };
    expect(runsAsAwsRole(host("Kubernetes.Deployment", { cluster: eks }))).toBe(false);
    expect(runsAsAwsRole(host("AWS.Batch.JobDefinition"))).toBe(false);
  });

  it("rejects hosts outside AWS", () => {
    expect(runsAsAwsRole(host("Cloudflare.Worker"))).toBe(false);
    expect(runsAsAwsRole(host("GCP.Run.Service"))).toBe(false);
  });
});

const { test: liveTest } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), GCP.providers()),
});

class PublishNotReady extends Data.TaggedError("PublishNotReady")<{ reason: string }> {}

describe(
  "GCP bindings on an AWS IAM role host",
  { tags: ["provider:aws", "provider:gcp", "provider:aws:lambda", "live"] },
  () => {
    liveTest.provider(
      "Lambda reaches Pub/Sub through workload identity federation",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const out = yield* stack.deploy(
            Effect.gen(function* () {
              const fn = yield* FederatedLambda;
              const events = yield* Events;
              const inbox = yield* GCP.PubSub.Subscription("FederatedInbox", {
                topic: events.name,
              });
              return {
                url: fn.functionUrl.as<string>(),
                functionName: fn.functionName,
                roleArn: fn.roleArn,
                subscription: inbox.name,
              };
            }).pipe(Effect.provide(FederatedLambdaLive)),
          );

          // The Lambda has no GCP key, only the provider and account it
          // federates through.
          const config = yield* lambda.getFunctionConfiguration({
            FunctionName: out.functionName,
          });
          const env = Object.fromEntries(
            Object.entries(config.Environment?.Variables ?? {}).map(([name, value]) => [
              name,
              typeof value === "string" || value === undefined ? value : Redacted.value(value),
            ]),
          );
          expect(env.ALCHEMY_GCP_SERVICE_ACCOUNT_KEY).toBeUndefined();
          const audience = env.ALCHEMY_GCP_WORKLOAD_IDENTITY_AUDIENCE;
          expect(audience).toMatch(
            /^\/\/iam\.googleapis\.com\/projects\/\d+\/locations\/global\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/,
          );
          const email = env.ALCHEMY_GCP_WORKLOAD_IDENTITY_SERVICE_ACCOUNT!;
          expect(email).toMatch(/\.iam\.gserviceaccount\.com$/);

          const keys = yield* iam.listProjectsServiceAccountsKeys({
            name: `projects/-/serviceAccounts/${email}`,
            keyTypes: ["USER_MANAGED"],
          });
          expect(keys.keys ?? []).toEqual([]);

          const pool = audience!.replace("//iam.googleapis.com/", "").split("/providers/")[0];
          const [, partition, , , account, resource] = out.roleArn.split(":");
          const principal = `principalSet://iam.googleapis.com/${pool}/attribute.aws_role/arn:${partition}:sts::${account}:assumed-role/${resource!.split("/").pop()}`;
          const policy = yield* iam.getIamPolicyProjectsServiceAccounts({
            resource: `projects/-/serviceAccounts/${email}`,
          });
          expect(
            (policy.bindings ?? []).find(
              (binding) => binding.role === "roles/iam.workloadIdentityUser",
            )?.members,
          ).toEqual([principal]);

          // A grant to a federated principal takes minutes to propagate
          // (IAM documents up to 7), as does the account's topic grant.
          const published = yield* HttpClient.get(out.url).pipe(
            Effect.flatMap((response) =>
              response.text.pipe(
                Effect.flatMap((body) =>
                  response.status === 200
                    ? Effect.succeed(JSON.parse(body) as { messageIds?: string[] })
                    : Effect.fail(new PublishNotReady({ reason: `${response.status} ${body}` })),
                ),
              ),
            ),
            Effect.mapError((error) =>
              error._tag === "PublishNotReady"
                ? error
                : new PublishNotReady({ reason: String(error) }),
            ),
            Effect.tapError((error) => Effect.logInfo(`publish not ready: ${error.reason}`)),
            Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 42 }),
          );
          expect(published.messageIds?.length).toBe(1);

          const pulled = yield* pubsub
            .pullProjectsSubscriptions({
              subscription: out.subscription,
              body: { maxMessages: 1 },
            })
            .pipe(
              Effect.repeat({
                until: (response) => (response.receivedMessages ?? []).length > 0,
                schedule: Schedule.spaced("2 seconds"),
                times: 10,
              }),
            );
          expect(atob(pulled.receivedMessages?.[0]?.message?.data ?? "")).toBe("hello from lambda");

          yield* stack.destroy();

          const gone = yield* iam
            .getProjectsServiceAccounts({
              name: `projects/${env.ALCHEMY_GCP_WORKLOAD_IDENTITY_PROJECT}/serviceAccounts/${email}`,
            })
            .pipe(
              Effect.as(false),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            );
          expect(gone).toBe(true);
        }),
      { timeout: 900_000 },
    );
  },
);
