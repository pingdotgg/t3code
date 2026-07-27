import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { Region } from "@distilled.cloud/aws/Region";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import type { ResourceLike } from "../../Resource.ts";
import type {
  AwsCredentialProviderError,
  ResolvedCredentials,
} from "@distilled.cloud/aws/Credentials";
import { Credentials, makeAssumeRoleResolver } from "../Credentials.ts";
import { AccessKey } from "../IAM/AccessKey.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { Role } from "../IAM/Role.ts";
import { User } from "../IAM/User.ts";
import { isBindingHost } from "./Function.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

// Shared scaffolding for the MicroVM runtime bindings. Every `*Http` impl is
// identical except for the distilled operation, the IAM action(s), the policy
// scope, and whether the bound image's identifier is injected into the request.
// NOT exported from `index.ts` — it only backs the per-operation `*Http` files.

/** The distilled operation method, yielded to its request callable. */
type Operation<Res, Err> = Effect.Effect<
  (req: any) => Effect.Effect<Res, Err, any>,
  any,
  any
>;

// We resolve the host (Worker vs Lambda) at both deploy AND runtime to decide
// how credentials are supplied. A Cloudflare Worker is structurally tagged with
// this Type id; a hard import of the Cloudflare module graph is avoided.
const WORKER_TYPE_ID = "Cloudflare.Worker";
type WorkerHost = ResourceLike & {
  bind: (
    sid: string,
  ) => (binding: Input<{ bindings?: unknown[] }>) => Effect.Effect<void>;
};
const isWorkerHost = (host: ResourceLike): host is WorkerHost =>
  (host as { Type?: string }).Type === WORKER_TYPE_ID;

/** Region segment of an AWS ARN (`arn:partition:service:<region>:...`). */
const regionFromArn = (arn: string): string => arn.split(":")[3] ?? "us-east-1";

// ---------------------------------------------------------------------------
// Per-scope singleton store. A Worker reaching AWS must create exactly ONE IAM
// User + AccessKey + Role (and one assumed-role credential cache) regardless of
// how many of the ~16 MicroVM `*Http` bindings it uses. A
// `WeakMap<Scope, Ref<HashMap>>` memoizes any keyed effect for the lifetime of
// the surrounding scope (the deploy plan, or the worker's runtime init scope),
// so every binding shares the same resources and the same credentials.
// ---------------------------------------------------------------------------

const perScope = new WeakMap<
  Scope.Scope,
  Ref.Ref<HashMap.HashMap<string, unknown>>
>();
// Fallback when no `Scope` is in context — notably a deployed Worker's init
// phase, which runs outside any scope. Process-wide is an acceptable singleton
// granularity there (one isolate == one logical host).
const globalStore = new Map<string, unknown>();

const storeRef = Effect.gen(function* () {
  const scope = yield* Effect.serviceOption(Scope.Scope);
  if (Option.isNone(scope)) return undefined;
  let ref = perScope.get(scope.value);
  if (!ref) {
    ref = yield* Ref.make(HashMap.empty<string, unknown>());
    perScope.set(scope.value, ref);
  }
  return ref;
});

const memoize = <A, E, R>(key: string, build: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const ref = yield* storeRef;
    if (ref) {
      const existing = HashMap.get(yield* Ref.get(ref), key);
      if (Option.isSome(existing)) return existing.value as A;
      const value = yield* build;
      yield* Ref.update(ref, HashMap.set(key, value as unknown));
      return value;
    }
    if (globalStore.has(key)) return globalStore.get(key) as A;
    const value = yield* build;
    globalStore.set(key, value);
    return value;
  }) as Effect.Effect<A, E, R>;

export interface ImageBindingOptions<Req, Res, Err, Self> {
  /** The `Binding.Service` contract this layer implements. */
  binding: Binding.Service<
    Self,
    string,
    (
      image: MicrovmImage,
    ) => Effect.Effect<(req: Req) => Effect.Effect<Res, Err>>
  >;
  /** Operation name, used for the SID label and tracing, e.g. `"RunMicrovm"`. */
  name: string;
  /** IAM action(s) the host Function needs, e.g. `["lambda:RunMicrovm"]`. */
  actions: string[];
  /** The distilled operation, e.g. `microvms.runMicrovm`. */
  operation: Operation<Res, Err>;
  /**
   * Policy scope (always limited to the bound image's identity — never `["*"]`):
   * - `"image"` (default) scopes to the exact image ARN (e.g. `RunMicrovm`,
   *   image-read ops).
   * - `"microvm"` scopes to the MicroVM instances launched from this image via
   *   a `microvm:*` glob derived from the image ARN (same partition, region,
   *   and account). MicroVM instance ARNs are minted at runtime, so an exact
   *   ARN can't be known at deploy time, but the action stays bounded to this
   *   account/region's MicroVMs rather than `["*"]`.
   * - `"account"` uses `["*"]`. Reserved for collection-level list actions
   *   (e.g. `ListMicrovms`) that AWS only authorizes against `*` and cannot be
   *   resource-scoped, analogous to `ec2:DescribeInstances`.
   */
  scope?: "image" | "microvm" | "account";
  /** Inject `imageIdentifier: <imageArn>` into each request. */
  injectImageIdentifier?: boolean;
  /**
   * Also grant `lambda:PassNetworkConnector` on network connectors in the
   * image's region — both the account's own connectors and the AWS-managed
   * ones (e.g. `INTERNET_EGRESS`). Required by `RunMicrovm`, which passes a
   * network connector (defaulting to the managed `INTERNET_EGRESS`) to the
   * launched MicroVM.
   */
  passNetworkConnector?: boolean;
}

/**
 * Derive the `microvm:*` instance-ARN glob from an image ARN by swapping the
 * `microvm-image:<name>` resource segment for `microvm:*`, keeping the same
 * `arn:<partition>:lambda:<region>:<account>:` prefix.
 */
const microvmGlob = (imageArn: string): string =>
  `${imageArn.replace(/:microvm-image[:/].*$/, "")}:microvm:*`;

/**
 * Derive the network-connector ARN globs from an image ARN: the account's own
 * connectors (`arn:<partition>:lambda:<region>:<account>:network-connector:*`)
 * and the AWS-managed connectors (same prefix but account `aws`).
 */
const networkConnectorGlobs = (imageArn: string): string[] => {
  // arn:<partition>:lambda:<region>:<account>
  const prefix = imageArn.replace(/:microvm-image[:/].*$/, "");
  // arn:<partition>:lambda:<region>
  const regionPrefix = prefix.replace(/:[^:]*$/, "");
  return [
    `${prefix}:network-connector:*`,
    `${regionPrefix}:aws:network-connector:*`,
  ];
};

/** The IAM policy statements an image-scoped MicroVM operation requires. */
const imagePolicyStatements = <Req, Res, Err, Self>(
  image: MicrovmImage,
  options: ImageBindingOptions<Req, Res, Err, Self>,
): Input<PolicyStatement>[] => [
  {
    Effect: "Allow",
    Action: options.actions,
    Resource:
      options.scope === "account"
        ? // Collection-level list actions only authorize on `*`.
          ["*"]
        : options.scope === "microvm"
          ? [
              // Instance ops (GetMicrovm, TerminateMicrovm, CreateAuthToken,
              // …) are authorized by AWS against the image ARN as well as the
              // instance ARN, so grant both: the exact image and the
              // `microvm:*` instance glob derived from it.
              Output.interpolate`${image.imageArn}`,
              image.imageArn.pipe(Output.map(microvmGlob)),
            ]
          : [Output.interpolate`${image.imageArn}`],
  },
  ...(options.passNetworkConnector
    ? [
        {
          Effect: "Allow" as const,
          Action: ["lambda:PassNetworkConnector"],
          Resource: [
            image.imageArn.pipe(
              Output.map((a) => networkConnectorGlobs(a)[0]!),
            ),
            image.imageArn.pipe(
              Output.map((a) => networkConnectorGlobs(a)[1]!),
            ),
          ],
        },
      ]
    : []),
];

interface WorkerAwsAccess {
  /** The shared least-privilege Role each binding contributes statements to. */
  readonly role: Role;
  /**
   * Shared assumed-role credentials resolver, single-flight + expiry-aware,
   * built ONCE per host (see {@link ensureWorkerAwsAccess}). Every binding and
   * every request reuses this exact resolver, so `AssumeRole` runs once and is
   * re-run only when the cached credentials approach expiry — never per request.
   */
  readonly credentials: Effect.Effect<
    ResolvedCredentials,
    AwsCredentialProviderError
  >;
}

/**
 * Create — once per scope, per host worker — the IAM identity a Cloudflare
 * Worker uses to reach AWS:
 *   - an IAM **User** allowed to assume any role that trusts it,
 *   - a long-lived **AccessKey** for that user,
 *   - a least-privilege **Role** the user assumes (trusts only this user;
 *     MicroVM permissions accumulate on it via `role.bind`).
 *
 * The user's access key + the role ARN are read as {@link Output} *accessors*
 * (`yield* accessKey.accessKeyId`, …) — yielding an attribute both registers
 * the binding on the worker (deploy) and returns an `Effect` that reads it at
 * runtime. At runtime those accessors feed an assume-role credentials layer
 * (single-flight, expiry-aware) built once and shared across all bindings.
 */
const ensureWorkerAwsAccess = (host: WorkerHost) =>
  memoize(
    `microvm-aws:${(host as ResourceLike).LogicalId}`,
    Effect.gen(function* (): Generator<any, WorkerAwsAccess, any> {
      const id = (host as ResourceLike).LogicalId;

      // The user may assume any role that trusts it (Resource `*`); the role's
      // trust policy is what actually restricts assumption to this user, which
      // avoids a User↔Role ARN dependency cycle while staying safe.
      const user = yield* User(`${id}-microvm-user`, {
        inlinePolicies: {
          "assume-microvm-role": {
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Action: ["sts:AssumeRole"], Resource: ["*"] },
            ],
          },
        },
      });

      const accessKey = yield* AccessKey(`${id}-microvm-key`, {
        userName: user.userName,
      });

      const role = yield* Role(`${id}-microvm-role`, {
        assumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { AWS: user.userArn },
              Action: ["sts:AssumeRole"],
            },
          ],
        },
      });

      // Bind the user's credentials + role ARN onto the worker via accessors:
      // at deploy this registers the env (the secret as `secret_text`); at
      // runtime these resolve to the deployed values.
      const accessKeyId = yield* accessKey.accessKeyId;
      const secretAccessKey = yield* accessKey.secretAccessKey;
      const roleArn = yield* role.roleArn;

      // The long-lived IAM-user credentials that sign `AssumeRole`. Read lazily
      // from the worker environment on each refresh (NOT captured eagerly, so
      // this is valid at deploy time where the env isn't populated yet).
      const base = Layer.succeed(
        Credentials,
        Effect.gen(function* () {
          const id = yield* accessKeyId;
          const secret = yield* secretAccessKey;
          return {
            accessKeyId: Redacted.make(id),
            secretAccessKey: secret
              ? Redacted.isRedacted(secret)
                ? secret
                : Redacted.make(secret)
              : Redacted.make(""),
            sessionToken: undefined,
          } satisfies ResolvedCredentials;
        }),
      );

      // Build the single-flight, expiry-aware assume-role cache ONCE. STS is
      // global, so the endpoint region is a fixed default; the per-request
      // operation provides its own image-derived `Region` separately.
      const credentials = yield* makeAssumeRoleResolver({
        roleArn,
        base,
        region: "us-east-1",
      });

      return { role, credentials };
    }),
  );

/**
 * Run a MicroVM operation with host-appropriate AWS credentials:
 * - Lambda Function host → the execution-role credentials already in the
 *   ambient environment (nothing to provide).
 * - Cloudflare Worker host → the assumed-role credentials, plus a `Region`
 *   derived from the image ARN and an `HttpClient`.
 */
const withRuntimeCredentials = <A, E>(
  access: WorkerAwsAccess | undefined,
  region: Effect.Effect<string>,
  eff: Effect.Effect<A, E, any>,
): Effect.Effect<A, E, any> =>
  access
    ? Effect.gen(function* () {
        const reg = yield* region;
        // Provide the SHARED cached resolver built once in
        // `ensureWorkerAwsAccess` — NOT a fresh assume-role layer per request —
        // so the assumed-role credentials are reused (and only refreshed near
        // expiry) instead of re-assuming the role on every call.
        return yield* eff.pipe(
          Effect.provide(Layer.succeed(Credentials, access.credentials)),
          Effect.provide(Layer.succeed(Region, Effect.succeed(reg))),
          Effect.provide(FetchHttpClient.layer),
        );
      })
    : eff;

/**
 * Build a MicroVM runtime binding bound to a {@link MicrovmImage}. At deploy it
 * registers the IAM grant on the host — the Lambda execution role directly, or
 * (for a Cloudflare Worker) a dedicated assume-role Role whose credentials are
 * bound onto the worker. At runtime it calls the distilled operation with the
 * host-appropriate credentials.
 */
export const makeImageBinding = <Req, Res, Err, Self>(
  options: ImageBindingOptions<Req, Res, Err, Self>,
): Layer.Layer<Self> =>
  Layer.effect(
    options.binding as any,
    Effect.gen(function* () {
      const run = yield* options.operation;
      return Effect.fn(function* (image: MicrovmImage) {
        const host = yield* Binding.Host;
        const statements = imagePolicyStatements(image, options);
        const label = `Allow(${host.LogicalId}, AWS.Lambda.${options.name}(${image.LogicalId}))`;

        // Accessors (registered on the host at deploy, resolved at runtime).
        const imageArn = yield* image.imageArn;
        // Region is derived from the resolved image ARN — via `Effect.map` of
        // the accessor, NOT a second Output binding (whose env key would embed
        // the mapper's source text and is brittle).
        const region = Effect.map(imageArn, regionFromArn);

        let access: WorkerAwsAccess | undefined;
        if (isBindingHost(host)) {
          if (!globalThis.__ALCHEMY_RUNTIME__) {
            yield* host.bind`${label}`({ policyStatements: statements });
          }
        } else if (isWorkerHost(host)) {
          access = yield* ensureWorkerAwsAccess(host);
          if (!globalThis.__ALCHEMY_RUNTIME__) {
            yield* access.role.bind`${label}`({ policyStatements: statements });
          }
        }

        return Effect.fn(`AWS.Lambda.${options.name}(${image.LogicalId})`)(
          function* (request: Req) {
            return yield* withRuntimeCredentials(
              access,
              region,
              run(
                options.injectImageIdentifier
                  ? { ...(request as object), imageIdentifier: yield* imageArn }
                  : request,
              ),
            );
          },
        );
      });
    }),
  ) as unknown as Layer.Layer<Self>;

export interface AccountBindingOptions<Req, Res, Err, Self> {
  binding: Binding.Service<
    Self,
    string,
    () => Effect.Effect<(req: Req) => Effect.Effect<Res, Err>>
  >;
  name: string;
  actions: string[];
  operation: Operation<Res, Err>;
}

/**
 * Build an account-scoped MicroVM binding (no resource argument), e.g. for
 * listing AWS-managed base images. IAM `Resource` is `["*"]`.
 */
export const makeAccountBinding = <Req, Res, Err, Self>(
  options: AccountBindingOptions<Req, Res, Err, Self>,
): Layer.Layer<Self> =>
  Layer.effect(
    options.binding as any,
    Effect.gen(function* () {
      const run = yield* options.operation;
      return Effect.fn(function* () {
        const host = yield* Binding.Host;
        const label = `Allow(${host.LogicalId}, AWS.Lambda.${options.name}())`;
        const statements: Input<PolicyStatement>[] = [
          { Effect: "Allow", Action: options.actions, Resource: ["*"] },
        ];

        let access: WorkerAwsAccess | undefined;
        if (isBindingHost(host)) {
          if (!globalThis.__ALCHEMY_RUNTIME__) {
            yield* host.bind`${label}`({ policyStatements: statements });
          }
        } else if (isWorkerHost(host)) {
          access = yield* ensureWorkerAwsAccess(host);
          if (!globalThis.__ALCHEMY_RUNTIME__) {
            yield* access.role.bind`${label}`({ policyStatements: statements });
          }
        }

        return Effect.fn(`AWS.Lambda.${options.name}()`)(function* (
          request: Req,
        ) {
          // Account-level operations are global; default the STS/endpoint region.
          const region = Effect.succeed("us-east-1");
          return yield* withRuntimeCredentials(access, region, run(request));
        });
      });
    }),
  ) as unknown as Layer.Layer<Self>;
