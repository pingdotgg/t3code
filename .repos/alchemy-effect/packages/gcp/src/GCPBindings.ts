import {
  Credentials,
  fromServiceAccountKey,
  fromWorkloadIdentity,
} from "@distilled.cloud/gcp/Credentials";
import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { isResourceOfType, type ResourceLike } from "alchemy/Resource";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as rolldown from "rolldown";
import type { GcpIamGrant } from "./Host.ts";
import { Member } from "./IAM/Member.ts";
import { ServiceAccount } from "./IAM/ServiceAccount.ts";
import { ServiceAccountKey } from "./IAM/ServiceAccountKey.ts";
import { WorkloadIdentityPool } from "./IAM/WorkloadIdentityPool.ts";
import { WorkloadIdentityProvider } from "./IAM/WorkloadIdentityProvider.ts";

/**
 * How a GCP binding reaches GCP from its host:
 *
 * - the host runs as a service account (Cloud Run, Cloud Functions, a GKE
 *   pod): roles are granted to that account, and calls use its
 *   metadata-server credentials;
 * - the host runs as an AWS IAM role (Lambda, ECS, EC2, App Runner): Alchemy
 *   creates a service account, grants the roles to it, and lets the role
 *   impersonate it through a workload identity pool that trusts the AWS
 *   account. The host exchanges a signed `GetCallerIdentity` request for the
 *   account's token; no key is created;
 * - any other host (a Cloudflare Worker, an EKS pod): Alchemy creates a
 *   service account and key for it, grants the roles to that account, and
 *   binds the key into the host's env;
 * - no host (a script or deploy-time Action): nothing is bound and calls use
 *   the deployer's credentials.
 *
 * Import it as a namespace. A binding resolves its operations with
 * {@link withCredentials} and gets its `bind` from {@link Bind} when its layer
 * is built, then binds behind its own `__ALCHEMY_RUNTIME__` guard:
 *
 * ```ts
 * Effect.gen(function* () {
 *   const publish = yield* GCPBindings.withCredentials(pubsub.publishProjectsTopics);
 *   const bind = yield* GCPBindings.Bind;
 *   return Effect.fn(function* (topic: Topic) {
 *     if (!globalThis.__ALCHEMY_RUNTIME__) {
 *       yield* bind`GCP.PubSub.WriteTopic(${topic})`({
 *         iam: [{ role: "roles/pubsub.publisher", resource: { kind: "pubsub.topic", name: topic.name } }],
 *       });
 *     }
 *     return (message) => publish({ topic: …, body: … });
 *   });
 * })
 * ```
 */

/** What a GCP binding attaches to its host. */
export interface HostBinding {
  /** The IAM roles the binding needs. */
  readonly iam?: Input<GcpIamGrant>[];
  /** Env vars the binding reads at runtime. */
  readonly env?: Record<string, unknown>;
}

/**
 * Build options for a bundle that runs on a host running as a GCP service account (Cloud Run, Cloud Functions, GKE): defines
 * `__ALCHEMY_HOST_IDENTITY__` as `"GCP.IAM.ServiceAccount"` so the bundler drops the created-key credentials path.
 */
export const serviceAccountHostBundle = (input: rolldown.InputOptions): rolldown.InputOptions => ({
  ...input,
  transform: {
    ...input.transform,
    define: {
      ...input.transform?.define,
      "globalThis.__ALCHEMY_HOST_IDENTITY__": JSON.stringify("GCP.IAM.ServiceAccount"),
    },
  },
});

/**
 * Env vars holding the key Alchemy creates for a host that doesn't run as a
 * service account. Only {@link Bind} sets them, and only on that path, so
 * at runtime their presence is the whole decision.
 */
const KEY_ENV = {
  email: "ALCHEMY_GCP_SERVICE_ACCOUNT_EMAIL",
  project: "ALCHEMY_GCP_SERVICE_ACCOUNT_PROJECT",
  privateKeyId: "ALCHEMY_GCP_SERVICE_ACCOUNT_KEY_ID",
  privateKey: "ALCHEMY_GCP_SERVICE_ACCOUNT_KEY",
} as const;

/**
 * Env vars for a host that runs as an AWS IAM role: the workload identity
 * provider it exchanges its AWS identity at, and the service account it
 * impersonates. Only {@link Bind} sets them, on that path only.
 */
const FEDERATION_ENV = {
  audience: "ALCHEMY_GCP_WORKLOAD_IDENTITY_AUDIENCE",
  email: "ALCHEMY_GCP_WORKLOAD_IDENTITY_SERVICE_ACCOUNT",
  project: "ALCHEMY_GCP_WORKLOAD_IDENTITY_PROJECT",
} as const;

/**
 * The attribute holding the IAM role ARN each AWS host type runs as.
 *
 * TODO: don't hard-code AWS host types in the GCP package. The AWS package
 * owns them; find a way for it to provide this, e.g. as a Layer the GCP
 * binding reads at deploy time.
 */
const AWS_ROLE_ARN_ATTRIBUTE: Record<string, string> = {
  "AWS.Lambda.Function": "roleArn",
  "AWS.Lambda.WebFunction": "roleArn",
  "AWS.ECS.Task": "taskRoleArn",
  "AWS.ECS.Service": "taskRoleArn",
  "AWS.EC2.Instance": "roleArn",
  "AWS.AutoScaling.LaunchTemplate": "roleArn",
  "AWS.AppRunner.Service": "instanceRoleArn",
};

/**
 * Whether a host runs its code as an AWS IAM role GCP can federate with:
 * Lambda, ECS, EC2, an EC2 launch template, or App Runner. Not an EKS pod or
 * a Batch job, which keep a key. Deploy-time only.
 */
export const runsAsAwsRole = (host: ResourceLike): boolean =>
  Object.hasOwn(AWS_ROLE_ARN_ATTRIBUTE, host.Type);

/**
 * Id of the AWS provider in the stack's pool. Fixed so a host's env can name
 * the provider by the pool alone: the provider reads the host's role (for
 * the AWS account), so naming it by its own output would be a cycle.
 */
const AWS_PROVIDER_ID = "alchemy-aws";

/** `arn:aws:iam::123:role/path/name` → `arn:aws:sts::123:assumed-role/name`. */
const assumedRoleArn = (roleArn: string) => {
  const [, partition, , , account, resource] = roleArn.split(":");
  const name = resource?.split("/").pop();
  return `arn:${partition}:sts::${account}:assumed-role/${name}`;
};

/**
 * Maps an AWS caller to the role it assumed, so a grant to
 * `attribute.aws_role/arn:aws:sts::<account>:assumed-role/<role>` matches
 * every session of that role. `google.subject` is the bounded `userid`
 * (`<role id>:<session>`): a full assumed-role ARN can exceed its 127 bytes.
 */
const AWS_ATTRIBUTE_MAPPING = {
  "google.subject": "assertion.userid",
  "attribute.aws_role":
    "assertion.arn.contains('assumed-role') ? assertion.arn.extract('{account_arn}assumed-role/') + 'assumed-role/' + assertion.arn.extract('assumed-role/{role_name}/') : assertion.arn",
};

/**
 * Whether a host runs its code as a GCP service account: Cloud Run, Cloud
 * Functions, or a Kubernetes workload on a GKE cluster (Workload Identity).
 * Deploy-time only: it reads the host's props.
 */
export const runsAsServiceAccount = (host: ResourceLike): boolean => {
  switch (host.Type) {
    case "GCP.Run.Service":
    case "GCP.Run.Container":
    case "GCP.Run.Job":
    case "GCP.Run.WorkerPool":
    case "GCP.CloudFunctions.Function":
      return true;
    case "Kubernetes.Deployment":
    case "Kubernetes.Job":
      return isGkeCluster(host.Props?.cluster);
    default:
      return false;
  }
};

/** A `GCP.Container.Cluster`, or a cluster connection authenticating as `gcp-gke`. */
const isGkeCluster = (cluster: unknown): boolean => {
  if (isResourceOfType(cluster, "GCP.Container.Cluster")) return true;
  const value = cluster as { auth?: { kind?: string }; connection?: { auth?: { kind?: string } } };
  return value?.auth?.kind === "gcp-gke" || value?.connection?.auth?.kind === "gcp-gke";
};

/** Label a grant `Allow(<host>, <label>)`, as `host.bind` records it. */
const allow = (label: TemplateStringsArray): TemplateStringsArray => {
  const strings = ["Allow(", `, ${label[0]}`, ...label.slice(1)];
  strings[strings.length - 1] += ")";
  return Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray;
};

type BindTarget = {
  bind: (...args: unknown[]) => (data: unknown) => Effect.Effect<void>;
};

/**
 * The `bind` for a binding's layer: yield it while the layer is built, then
 * call it from the returned function, behind a literal
 * `if (!globalThis.__ALCHEMY_RUNTIME__)` so the bundler drops it. It attaches
 * the binding to its host labelled `Allow(<host>, <label>)`:
 *
 * - a host that runs as a service account takes the roles on that account;
 * - a host that runs as an AWS IAM role gets a service account the role may
 *   impersonate through a workload identity pool; the account takes the roles;
 * - any other host gets a service account and key; the account takes the
 *   roles and the key is bound into the host's env.
 *
 * ```ts
 * Effect.gen(function* () {
 *   const bind = yield* GCPBindings.Bind;
 *   return Effect.fn(function* (topic: Topic) {
 *     if (!globalThis.__ALCHEMY_RUNTIME__) {
 *       yield* bind`GCP.PubSub.WriteTopic(${topic})`({ iam: [ … ] });
 *     }
 *   });
 * })
 * ```
 */
/** The signature {@link Bind} yields. */
export type BindHost = (
  label: TemplateStringsArray,
  ...args: unknown[]
) => (data: HostBinding) => Effect.Effect<void>;

export const Bind: Effect.Effect<BindHost> = Effect.gen(function* () {
  // Bindings only bind at deploy, so a host bundle captures nothing here
  // and drops the identity resources.
  if (globalThis.__ALCHEMY_RUNTIME__) return () => () => Effect.void;
  const GcpServiceAccount = yield* ServiceAccount;
  const GcpServiceAccountKey = yield* ServiceAccountKey;
  const GcpWorkloadIdentityPool = yield* WorkloadIdentityPool;
  const GcpWorkloadIdentityProvider = yield* WorkloadIdentityProvider;
  const GcpMember = yield* Member;

  return (label: TemplateStringsArray, ...args: unknown[]) =>
    Effect.fn(function* (data: HostBinding) {
      const host = yield* Binding.Host;
      if (host === undefined) return;

      if (runsAsServiceAccount(host)) {
        return yield* (host as unknown as BindTarget).bind(allow(label), host, ...args)(data);
      }

      const account = yield* GcpServiceAccount(`${host.LogicalId}ServiceAccount`, {
        displayName: `Alchemy: GCP access for ${host.LogicalId}`.slice(0, 100),
      });
      if (data.iam !== undefined && data.iam.length > 0) {
        yield* (account as unknown as BindTarget).bind(
          allow(label),
          host,
          ...args,
        )({
          iam: data.iam,
        });
      }
      const runtime = (yield* CurrentRuntimeContext)!;

      if (runsAsAwsRole(host)) {
        const roleArn = (host as unknown as Record<string, Output.Output<string>>)[
          AWS_ROLE_ARN_ATTRIBUTE[host.Type]!
        ]!;
        // One pool and provider serve every AWS host in the stack: a second
        // declaration of the same id resolves to the first.
        const pool = yield* GcpWorkloadIdentityPool("AwsWorkloadIdentityPool", {
          displayName: "Alchemy AWS hosts",
        });
        yield* GcpWorkloadIdentityProvider("AwsWorkloadIdentityProvider", {
          workloadIdentityPoolId: pool.workloadIdentityPoolId,
          workloadIdentityPoolProviderId: AWS_PROVIDER_ID,
          displayName: "Alchemy AWS hosts",
          aws: { accountId: Output.map(roleArn, (arn) => arn.split(":")[4]!) },
          attributeMapping: AWS_ATTRIBUTE_MAPPING,
        });
        yield* GcpMember(`${host.LogicalId}WorkloadIdentityUser`, {
          kind: "iam.serviceAccount",
          name: Output.interpolate`projects/${account.project}/serviceAccounts/${account.email}`,
          role: "roles/iam.workloadIdentityUser",
          member: Output.interpolate`principalSet://iam.googleapis.com/${pool.name}/attribute.aws_role/${Output.map(roleArn, assumedRoleArn)}`,
        });
        yield* runtime.set(
          FEDERATION_ENV.audience,
          Output.interpolate`//iam.googleapis.com/${pool.name}/providers/${AWS_PROVIDER_ID}`,
        );
        yield* runtime.set(FEDERATION_ENV.email, account.email);
        yield* runtime.set(FEDERATION_ENV.project, account.project);
        for (const [name, value] of Object.entries(data.env ?? {})) {
          yield* runtime.set(name, Output.isOutput(value) ? value : Output.literal(value));
        }
        return;
      }

      const key = yield* GcpServiceAccountKey(`${host.LogicalId}ServiceAccountKey`, {
        serviceAccount: account.email,
      });
      yield* runtime.set(KEY_ENV.email, account.email);
      yield* runtime.set(KEY_ENV.project, account.project);
      yield* runtime.set(KEY_ENV.privateKeyId, key.privateKeyId);
      yield* runtime.set(KEY_ENV.privateKey, key.privateKey);
      for (const [name, value] of Object.entries(data.env ?? {})) {
        yield* runtime.set(name, Output.isOutput(value) ? value : Output.literal(value));
      }
    });
});

/**
 * The subject token an AWS host exchanges at Google STS: a `GetCallerIdentity`
 * request signed with the host's own role credentials (env, container or
 * instance metadata), bound to `audience` by the signed
 * `x-goog-cloud-target-resource` header. Google replays it against AWS STS to
 * learn the caller. Built again on every token refresh.
 */
const awsSubjectToken = (audience: string) =>
  Effect.gen(function* () {
    // Loaded on AWS hosts only: the Node credential chain has no browser build.
    const aws = yield* Effect.promise(() => import("@distilled.cloud/aws/Credentials"));
    const { sign } = yield* Effect.promise(() => import("@distilled.cloud/aws4signer"));
    const creds = yield* Effect.gen(function* () {
      const resolve = yield* aws.Credentials;
      return yield* resolve;
    }).pipe(Effect.provide(aws.fromNodeProviderChain()));
    const region = yield* Config.String("AWS_REGION").pipe(
      Config.withDefault(creds.region ?? "us-east-1"),
    );
    const signed = yield* sign({
      method: "POST",
      url: `https://sts.${region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15`,
      headers: { "x-goog-cloud-target-resource": audience },
      accessKeyId: Redacted.value(creds.accessKeyId),
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
      service: "sts",
      region,
    });
    const headers = { host: new URL(signed.url).host, ...signed.headers };
    return Redacted.make(
      encodeURIComponent(
        JSON.stringify({
          url: signed.url,
          method: signed.method,
          headers: Object.entries(headers).map(([key, value]) => ({ key, value })),
        }),
      ),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

/**
 * Resolve a distilled operation with the host's GCP credentials, once when
 * the binding's layer is built: with the key {@link Bind} created for this
 * host if there is one, as-is otherwise (the host's own service account, or
 * the deployer).
 */
export const withCredentials: <Op>(operation: Effect.Effect<Op, never, any>) => Effect.Effect<Op> =
  Effect.fn(function* <Op>(operation: Effect.Effect<Op, never, any>) {
    // A host running as a service account signs with its own credentials.
    if (globalThis.__ALCHEMY_HOST_IDENTITY__ === "GCP.IAM.ServiceAccount")
      return yield* operation as Effect.Effect<Op>;
    const runtime = yield* CurrentRuntimeContext;
    // A host running as an AWS IAM role federates; it never has a key.
    if (globalThis.__ALCHEMY_HOST_IDENTITY__ === "AWS.IAM.Role") {
      const audience =
        globalThis.__ALCHEMY_RUNTIME__ && runtime !== undefined
          ? yield* runtime.get<string>(FEDERATION_ENV.audience)
          : undefined;
      if (runtime === undefined || audience === undefined) {
        return yield* operation as Effect.Effect<Op>;
      }
      const federated = fromWorkloadIdentity({
        audience,
        serviceAccountEmail: (yield* runtime.get<string>(FEDERATION_ENV.email))!,
        project: yield* runtime.get<string>(FEDERATION_ENV.project),
        subjectToken: awsSubjectToken(audience),
        subjectTokenType: "urn:ietf:params:aws:token-type:aws4_request",
      });
      const credentials = Context.get(
        yield* Layer.build(federated).pipe(Effect.scoped),
        Credentials,
      );
      return yield* (operation as Effect.Effect<Op>).pipe(
        Effect.provide(
          Layer.mergeAll(Layer.succeed(Credentials, credentials), FetchHttpClient.layer),
        ),
      );
    }
    const email =
      globalThis.__ALCHEMY_RUNTIME__ && runtime !== undefined
        ? yield* runtime.get<string>(KEY_ENV.email)
        : undefined;
    if (runtime === undefined || email === undefined) {
      return yield* operation as Effect.Effect<Op>;
    }
    const privateKey = yield* runtime.get<string | Redacted.Redacted<string>>(KEY_ENV.privateKey);
    const key = fromServiceAccountKey({
      clientEmail: email,
      project: (yield* runtime.get<string>(KEY_ENV.project))!,
      privateKeyId: (yield* runtime.get<string>(KEY_ENV.privateKeyId))!,
      privateKey: Redacted.isRedacted(privateKey) ? privateKey : Redacted.make(privateKey ?? ""),
    });
    const credentials = Context.get(yield* Layer.build(key).pipe(Effect.scoped), Credentials);
    return yield* (operation as Effect.Effect<Op>).pipe(
      Effect.provide(
        Layer.mergeAll(Layer.succeed(Credentials, credentials), FetchHttpClient.layer),
      ),
    );
  });

/**
 * Fail at deploy for a binding that needs its host to run as a service
 * account, e.g. one that reads ID tokens from the metadata server.
 */
export const requireServiceAccountHost = Effect.fn(function* (tag: string) {
  if (globalThis.__ALCHEMY_RUNTIME__) return;
  const host = yield* Binding.Host;
  if (host === undefined || runsAsServiceAccount(host)) return;
  return yield* Effect.die(
    new Error(
      `${tag} needs a host that runs as a GCP service account (Cloud Run, Cloud Functions or GKE), not ${host.Type} ${host.LogicalId}.`,
    ),
  );
});
