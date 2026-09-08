import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as iam from "@distilled.cloud/aws/iam";
import type { CreateFunctionRequest } from "@distilled.cloud/aws/lambda";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { Region } from "@distilled.cloud/aws/Region";
import type * as lambda from "aws-lambda";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type * as rolldown from "rolldown";
import { Unowned } from "../../AdoptPolicy.ts";
import type * as Bundle from "../../Bundle/Bundle.ts";
import type { PackageInstall } from "../../Bundle/InstalledPackages.ts";
import { deepEqual, havePropsChanged, isResolved } from "../../Diff.ts";
import { isScopeEjected, type HttpEffect } from "../../Http.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import type { LogLine, LogsInput } from "../../Provider.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { packEnvValue, unpackEnvValue } from "../../RuntimeContext.ts";
import * as Serverless from "../../Serverless/index.ts";
import { buildEventTelemetry } from "../../Telemetry.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
  hasTags,
} from "../../Tags.ts";
import { sha256 } from "../../Util/sha256.ts";
import { zipCode } from "../../Util/zip.ts";
import { Assets } from "../Assets.ts";
import { AWSEnvironment } from "../Environment.ts";
import * as IAM from "../IAM/index.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import {
  syncEventInvokeConfig,
  type EventInvokeConfig,
} from "./EventInvokeConfig.ts";
import { makeFunctionBundler } from "./FunctionBundle.ts";
import {
  decodeFunctionImageSource,
  type FunctionImageAttributes,
  type FunctionImageIdentity,
  type FunctionImageSource,
  makeFunctionImage,
} from "./FunctionImage.ts";
import { makeFunctionHttpHandler } from "./HttpServer.ts";

export type { FunctionImageSource } from "./FunctionImage.ts";

export const FunctionTypeId = "AWS.Lambda.Function" as const;
export type FunctionTypeId = typeof FunctionTypeId;

class FunctionUpdatePending extends Data.TaggedError("FunctionUpdatePending")<{
  functionName: string;
}> {}

class FunctionUpdateFailed extends Data.TaggedError("FunctionUpdateFailed")<{
  functionName: string;
  reason?: string;
}> {}

export class HandlerContext extends Context.Service<
  HandlerContext,
  lambda.Context
>()("AWS.Lambda.HandlerContext") {}

export const isFunction = (value: any): value is Function => {
  return (
    typeof value === "object" &&
    value !== null &&
    "Type" in value &&
    value.Type === "AWS.Lambda.Function"
  );
};

/**
 * True for any Alchemy host that accepts the `{ env, policyStatements }`
 * binding contract: the Lambda `Function`, the ECS `Task` and `Service`, and
 * the EKS `ServerHost`. AWS `Binding.Service` implementations guard their
 * deploy-time
 * `host.bind` registration with this predicate so every existing capability
 * (S3, DynamoDB, SQS, …) lands its IAM on whichever of the three hosts is in
 * context — the Lambda execution role, the ECS task role, or the EKS
 * pod-identity role.
 *
 * The type guard narrows to `Function` deliberately: all three hosts expose an
 * identical `{ env, policyStatements }` bind contract and only `host.bind` /
 * `host.LogicalId` are ever touched inside the guarded block, so downstream
 * typing is unchanged while the runtime check widens to all three.
 */
export const isBindingHost = (value: any): value is Function => {
  return (
    typeof value === "object" &&
    value !== null &&
    "Type" in value &&
    (value.Type === "AWS.Lambda.Function" ||
      value.Type === "AWS.ECS.Task" ||
      value.Type === "AWS.ECS.Service" ||
      value.Type === "Kubernetes.Deployment" ||
      value.Type === "Kubernetes.Job")
  );
};

export interface FunctionBuildOptions
  extends Partial<rolldown.InputOptions>, Bundle.BundleExtraOptions {
  /**
   * Native or Node-only packages to install into the Lambda artifact with npm,
   * targeting Linux and the function's architecture.
   *
   * @example
   * ```typescript
   * build: { install: ["sharp"] }
   * ```
   *
   * @example
   * ```typescript
   * build: { install: { sharp: "^0.33.5" } }
   * ```
   */
  readonly install?: PackageInstall;
  readonly output?: Partial<rolldown.OutputOptions>;
}

export type FunctionArchitecture = "x86_64" | "arm64";

/**
 * Overrides for instructions declared by a Lambda container image. Set
 * directly on {@link FunctionImageProps.image} alongside the image source;
 * omit to use the image's own `CMD` / `ENTRYPOINT` / `WORKDIR`.
 */
export interface FunctionImageConfig {
  /** Parameters passed to the image entry point, overriding Dockerfile `CMD`. */
  command?: readonly string[];
  /** Runtime executable, overriding Dockerfile `ENTRYPOINT`. */
  entryPoint?: readonly string[];
  /** Working directory, overriding Dockerfile `WORKDIR`. */
  workingDirectory?: string;
}

/**
 * Reference to an EFS access point: a raw access point ARN or anything
 * exposing an `accessPointArn` attribute (e.g. an `AWS.EFS.AccessPoint`
 * resource).
 */
export type AccessPointRef = string | { accessPointArn: string };

/**
 * Reference to a Lambda layer version: a raw layer version ARN or anything
 * exposing a `layerVersionArn` attribute (e.g. an `AWS.Lambda.LayerVersion`
 * resource).
 */
export type LayerRef = string | { layerVersionArn: string };

/** Resolve a {@link LayerRef} to its layer version ARN. */
export const layerVersionArnOf = (layer: LayerRef): string =>
  typeof layer === "string" ? layer : layer.layerVersionArn;

/**
 * Resolve an {@link AccessPointRef} (or the legacy raw-`arn` field) on a
 * `fileSystemConfigs` entry to the access point ARN.
 */
const accessPointArnOf = (config: {
  accessPoint?: AccessPointRef;
  arn?: string;
}): string | undefined =>
  typeof config.accessPoint === "string"
    ? config.accessPoint
    : typeof (config.accessPoint as { accessPointArn?: unknown } | undefined)
          ?.accessPointArn === "string"
      ? (config.accessPoint as { accessPointArn: string }).accessPointArn
      : config.arn;

export interface FunctionUrlConfig {
  /**
   * Authentication type for the Lambda function URL.
   * `NONE` creates a public endpoint. `AWS_IAM` requires SigV4-signed callers.
   * @default "NONE"
   */
  authType?: Lambda.FunctionUrlAuthType;
  /**
   * Cross-origin resource sharing configuration for the function URL.
   */
  cors?: Lambda.Cors;
  /**
   * Invocation mode for the function URL.
   * @default "BUFFERED"
   */
  invokeMode?: Lambda.InvokeMode;
}

export interface FunctionCommonProps extends PlatformProps {
  /**
   * Whether to create a Lambda function URL, or its configuration.
   * `functionUrl: true` creates a public Function URL with `authType: "NONE"`.
   * Set `functionUrl: false` to disable the Function URL.
   * @default true
   */
  functionUrl?: boolean | FunctionUrlConfig;
  functionName?: string;
  /**
   * Instruction set architecture for the Lambda function.
   */
  architecture?: FunctionArchitecture;
  memorySize?: number;
  env?: Record<string, any>;
  /**
   * Attach the function to a VPC for private AWS connectivity such as Aurora.
   */
  vpc?: {
    subnetIds: string[];
    securityGroupIds: string[];
  };
  /**
   * EFS file systems to mount into the function's execution environment.
   * Each entry mounts an EFS access point — pass the `AWS.EFS.AccessPoint`
   * resource itself (or its ARN) — at a local path that must begin with
   * `/mnt/`. Requires `vpc`: the function must be attached to a VPC that can
   * reach an available EFS mount target for the file system. The execution
   * role is automatically granted EFS client access
   * (`AmazonElasticFileSystemClientReadWriteAccess`).
   *
   * Prefer the host-agnostic `AWS.EFS.Mount` binding
   * (`yield* AWS.EFS.mount(accessPoint, { path: "/mnt/data" })` inside the
   * function body with the `AWS.EFS.MountLive` layer) — it wires the same
   * config plus least-privilege IAM through the binding channel and also
   * works on ECS.
   */
  fileSystemConfigs?: {
    /**
     * The EFS access point to mount — an `AWS.EFS.AccessPoint` resource or
     * its ARN. Exactly one of `accessPoint` or `arn` is required.
     */
    accessPoint?: AccessPointRef;
    /**
     * ARN of the EFS access point to mount
     * (e.g. `accessPoint.accessPointArn`). Alias of {@link accessPoint} for
     * raw-string configs.
     */
    arn?: string;
    /**
     * Local mount path inside the function. Must begin with `/mnt/`
     * (e.g. `/mnt/files`).
     */
    localMountPath: string;
  }[];
  /**
   * Maximum execution time before the function is forcibly terminated.
   * Rounded up to whole seconds.
   *
   * @default 3 seconds (AWS Lambda default)
   */
  timeout?: Duration.Duration;
  /**
   * Maximum number of concurrent executions reserved for this function.
   * Omit to remove the function-level reserved concurrency limit.
   */
  reservedConcurrentExecutions?: number;
  /**
   * AWS X-Ray tracing mode for the function.
   *
   * `"Active"` samples and records incoming requests as X-Ray traces and
   * attaches the `AWSXRayDaemonWriteAccess` managed policy to the execution
   * role so the runtime can publish trace segments. `"PassThrough"` only
   * forwards an upstream trace header without sampling.
   *
   * @default "PassThrough"
   */
  tracing?: "Active" | "PassThrough";
  /**
   * Asynchronous invocation settings (retries, event age, destinations) for
   * the unqualified function. Omit to remove any existing config and fall
   * back to Lambda's defaults (2 retries, 6-hour max event age, no
   * destinations). Use {@link AliasProps.eventInvokeConfig} to scope the
   * config to an alias instead.
   */
  eventInvokeConfig?: EventInvokeConfig;
}

export interface FunctionZipProps extends FunctionCommonProps {
  /**
   * Entry module for the bundled Lambda function.
   */
  main: string;
  /**
   * Set to `false` to skip bundling and deploy `main`'s directory as-is:
   * every file in the directory containing `main` ships in the code
   * archive, preserving relative paths. Use for framework outputs that are
   * already self-contained deployment units (e.g. nitro's
   * `.output/server`, OpenNext's server functions) where re-bundling can
   * break `require`s of packaged `node_modules`. Implies external mode:
   * `handler` names an export of `main`, and the Lambda handler string is
   * derived from `main`'s basename (e.g. `index.mjs` → `index.handler`).
   * @default true
   */
  bundle?: false;
  image?: never;
  /**
   * Exported handler symbol inside the bundled module.
   * @default "handler"
   */
  handler?: string;
  // TODO(sam): use a Layer instead so we can manage Effect platform?
  runtime?: "nodejs22.x" | "nodejs24.x";
  /**
   * Lambda layers to attach — pass an `AWS.Lambda.LayerVersion` resource
   * directly, or a raw layer version ARN (e.g. an AWS-managed layer). Layers
   * are extracted into `/opt` in the order given. Omit or pass `[]` to detach
   * every layer.
   */
  layers?: LayerRef[];
  /**
   * Bundler configuration for {@link main}: rolldown input options (flat),
   * `output` overrides, `install` for native packages, plus pure-annotation
   * options (`pure`) and the bundle analyzer. Top-level calls in `effect`,
   * `@effect/*`, `alchemy`, `@alchemy.run/*`, and `@distilled.cloud/*` are
   * annotated as pure by default so unused code from those packages is
   * tree-shaken; list additional packages via `pure.packages`, or disable
   * with `pure: false`.
   */
  build?: FunctionBuildOptions;
  uploadSourceMap?: boolean;
  exports?: string[];
  /**
   * Wire-level `DurableConfig` applied at `CreateFunction`.
   *
   * @internal Set exclusively by the `AWS.Lambda.DurableFunction` wrapper —
   * never set this directly. Durability is a **create-time** property of a
   * Lambda function, so a presence change replaces the function (see `diff`).
   * The base Function is otherwise durability-agnostic; author durable
   * orchestrators with `AWS.Lambda.DurableFunction`.
   */
  durableConfig?: Lambda.DurableConfig;
}

export interface FunctionImageProps extends FunctionCommonProps {
  main?: never;
  /**
   * Instruction set architecture for the Lambda function and its image build.
   * `x86_64` builds `linux/amd64`; `arm64` builds `linux/arm64`.
   */
  architecture: FunctionArchitecture;
  /**
   * Deploy an existing private ECR image, or build a Lambda-compatible image
   * from a local Docker context. Local builds use a managed private ECR
   * repository with content-addressed tags.
   */
  image: FunctionImageSource;
  handler?: never;
  runtime?: never;
  layers?: never;
  build?: never;
  uploadSourceMap?: never;
  exports?: never;
  // Durability needs a `main` for the orchestrator body — see
  // DurableFunctionProps.
  durableConfig?: never;
}

export type FunctionProps = FunctionZipProps | FunctionImageProps;

const isFunctionImageProps = (
  props: FunctionProps,
): props is FunctionImageProps => props.image !== undefined;

interface FunctionPackageValidationProps {
  image?: unknown;
  main?: unknown;
  handler?: unknown;
  runtime?: unknown;
  layers?: unknown;
  build?: unknown;
  uploadSourceMap?: unknown;
  exports?: unknown;
  durableConfig?: unknown;
}

/**
 * Validate package-mode exclusivity before any Lambda or ECR mutation.
 * @internal
 */
export const validateFunctionPackageProps = Effect.fn(
  "AWS.Lambda.validateFunctionPackageProps",
)(function* (id: string, props: FunctionPackageValidationProps) {
  if (props.image === undefined) {
    if (props.main === undefined) {
      return yield* Effect.fail(
        new Error(`Function(${id}): declare exactly one of main or image`),
      );
    }
    return;
  }

  const incompatible = [
    ["main", props.main],
    ["handler", props.handler],
    ["runtime", props.runtime],
    ["layers", props.layers],
    ["build", props.build],
    ["uploadSourceMap", props.uploadSourceMap],
    ["exports", props.exports],
    ["durableConfig", props.durableConfig],
  ].flatMap(([name, value]) => (value === undefined ? [] : [name]));
  if (incompatible.length > 0) {
    return yield* Effect.fail(
      new Error(
        `Function(${id}): image functions cannot use ZIP/runtime options: ${incompatible.join(", ")}`,
      ),
    );
  }
});

/**
 * The Lambda `ImageConfig` for an image source's overrides; `undefined` when
 * the source declares none, so the image's own instructions apply.
 */
const toLambdaImageConfig = (
  config: FunctionImageConfig | undefined,
): Lambda.ImageConfig | undefined =>
  config === undefined ||
  (config.command === undefined &&
    config.entryPoint === undefined &&
    config.workingDirectory === undefined)
    ? undefined
    : {
        Command: config.command === undefined ? undefined : [...config.command],
        EntryPoint:
          config.entryPoint === undefined ? undefined : [...config.entryPoint],
        WorkingDirectory: config.workingDirectory,
      };

/**
 * `UpdateFunctionConfiguration` preserves old image overrides when the field
 * is omitted. An empty object therefore means "clear overrides" on update.
 */
const imageConfigForUpdate = (
  props: FunctionProps,
): Lambda.ImageConfig | undefined =>
  isFunctionImageProps(props)
    ? (toLambdaImageConfig(props.image) ?? {})
    : undefined;

/**
 * The Lambda `Handler` string for a function's props: `<file>.<export>`.
 * Bundled functions always emit `index.js`; prebuilt directories
 * (`bundle: false`) keep `main`'s own basename. The export half honors
 * `handler` only outside Effect mode (see the note at the call site).
 */
const handlerStringOf = (props: FunctionZipProps): string => {
  const externalMode = props.isExternal || props.bundle === false;
  // `main` may be an unresolved Output during precreate (the stub's mock
  // code exports `index.*` anyway); the real Handler is applied at
  // reconcile, where props are resolved.
  const base =
    props.bundle === false && typeof props.main === "string"
      ? props.main
          .slice(
            Math.max(
              props.main.lastIndexOf("/"),
              props.main.lastIndexOf("\\"),
            ) + 1,
          )
          .replace(/\.[^.]+$/, "")
      : "index";
  return `${base}.${externalMode ? (props.handler ?? "default") : "default"}`;
};

/**
 * Normalize a {@link FunctionProps.timeout} to whole seconds.
 *
 * State JSON round-trips flatten a `Duration` to its `toJSON` shape
 * (`{_id:"Duration",_tag:"Millis"|"Nanos"|"Infinity",...}`), which is not a
 * valid `Duration.Input`. Reconstruct an input that `Duration.toSeconds`
 * accepts before delegating.
 */
export const toTimeoutSeconds = (
  timeout: Duration.Duration | undefined,
): number | undefined => {
  if (timeout === undefined) return undefined;
  const json = timeout as {
    _id?: unknown;
    _tag?: "Millis" | "Nanos" | "Infinity" | "NegativeInfinity";
    millis?: number;
    nanos?: string;
  };
  const input: Duration.Input =
    json._id === "Duration"
      ? json._tag === "Millis"
        ? json.millis!
        : json._tag === "Nanos"
          ? BigInt(json.nanos!)
          : "Infinity"
      : timeout;
  const seconds = Duration.toSeconds(input);
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : undefined;
};

export interface Function extends Resource<
  FunctionTypeId,
  FunctionProps,
  {
    functionArn: string;
    functionName: string;
    functionUrl: string | undefined;
    roleName: string;
    roleArn: string;
    code: {
      hash: string;
      image?: Omit<FunctionImageAttributes, "hash">;
    };
    reservedConcurrentExecutions?: number;
  },
  {
    env?: Record<string, any>;
    policyStatements?: PolicyStatement[];
    /**
     * VPC attachment requested by a binding (e.g. `RDS.Connect` with
     * `subnetIds`/`securityGroupIds`). Merged (set-union) with the
     * Function's own `vpc` prop and any other bindings' requests — both
     * paths converge on the same underlying Lambda VPC config.
     */
    vpc?: {
      subnetIds: string[];
      securityGroupIds: string[];
    };
    /**
     * EFS mounts requested through the binding channel (e.g. `EFS.Mount`).
     * Merged (deduped by `localMountPath`) with the Function's own
     * `fileSystemConfigs` prop.
     */
    fileSystemConfigs?: {
      /** ARN of the EFS access point to mount. */
      arn: string;
      /** Local mount path inside the function (must begin with `/mnt/`). */
      localMountPath: string;
    }[];
  },
  Providers
> {}

export type FunctionServices = Credentials | Region | AWSEnvironment;

export type FunctionShape = Main<FunctionServices>;

export interface NormalizedFunctionUrlConfig {
  authType: Lambda.FunctionUrlAuthType;
  cors?: Lambda.Cors;
  invokeMode: Lambda.InvokeMode;
}

export const normalizeFunctionUrl = (
  url: FunctionProps["functionUrl"] = true,
): NormalizedFunctionUrlConfig | undefined => {
  if (url === false) {
    return undefined;
  }
  if (url === true || url === undefined) {
    return {
      authType: "NONE",
      invokeMode: "BUFFERED",
    };
  }
  return {
    authType: url.authType ?? "NONE",
    cors: url.cors,
    invokeMode: url.invokeMode ?? "BUFFERED",
  };
};

/**
 * An AWS Lambda host resource that combines code bundling, IAM role
 * provisioning, and runtime binding collection.
 *
 * `Function` is the canonical runtime host for AWS. It can either bundle a
 * TypeScript entry module into a zip artifact or build a user-authored
 * Dockerfile into a Lambda container image. In both modes Alchemy creates the
 * execution role and applies bindings; image mode additionally owns the
 * private ECR repository and Lambda pull policy.
 *
 * Zip-packaged functions can be defined in two ways:
 *
 * - **Async** — plain handler export, no Effect runtime in the bundle.
 * - **Effect** — Effect implementation with typed bindings and event sources.
 *
 * See [Effect handlers vs async handlers](/infrastructure-as-effects/functions-and-servers#effect-handlers-vs-async-handlers)
 * for plain handler patterns, or the
 * [Lambda guide](/aws/compute/lambda)
 * for the full Effect-based approach with bindings, event sources, and sinks.
 *
 * :::caution[Request finalizers block the response — there is no `waitUntil` on Lambda]
 * `Effect.addFinalizer` in a handler runs **before the response is
 * returned**: a buffered invocation's response is not released until the
 * Invoke phase completes, and no deferral scheme is reliable (dangling
 * promises are dropped on crash/timeout resets and their sockets rarely
 * survive the freeze — silent data loss). Keep request finalizers cheap
 * (closing a pool is milliseconds), and write anything that must not be
 * lost durably — a queue, a table — inside the handler itself. Init-level
 * finalizers instead run in the 500 ms `SIGTERM` window at sandbox
 * shutdown, which the generated entry obtains by registering an internal
 * extension. See
 * [Sandbox scope vs invocation scope](/aws/compute/lambda#sandbox-scope-vs-invocation-scope).
 * :::
 * ### Async Functions
 * Point `main` at a file that exports a standard Lambda handler. No
 * Effect runtime is included in the bundle. Useful when migrating
 * existing Lambda functions or when you don't need Effect.
 *
 * **Example:** Defining an async Lambda in your stack
 * ```typescript
 * // alchemy.run.ts
 * import * as AWS from "alchemy/AWS";
 *
 * const func = yield* AWS.Lambda.Function("ApiFunction", {
 *   main: "./src/handler.ts",
 *   functionUrl: true,
 * });
 * ```
 *
 * **Example:** Function using ARM64
 * ```typescript
 * const func = yield* AWS.Lambda.Function("ArmFunction", {
 *   main: "./src/handler.ts",
 *   architecture: "arm64",
 * });
 * ```
 *
 * **Example:** Function with a native package (Sharp)
 * ```typescript
 * const func = yield* AWS.Lambda.Function("ImageProcessor", {
 *   main: "./src/handler.ts",
 *   architecture: "arm64",
 *   build: {
 *     install: ["sharp"],
 *   },
 * });
 * ```
 *
 * **Example:** Writing the async handler
 * ```typescript
 * // src/handler.ts
 * export const handler = async (event: any) => {
 *   return {
 *     statusCode: 200,
 *     body: JSON.stringify({ message: "Hello from Lambda!" }),
 *   };
 * };
 * ```
 *
 * ### Container Image Functions
 * Set `image` instead of `main` to deploy an existing private ECR image or to
 * build and publish a local Docker context. Image sources must be literal
 * because Lambda's pre-create phase needs the deployable image before normal
 * Output resolution.
 *
 * #### Existing ECR image with runtime overrides
 * ```typescript
 * const func = yield* AWS.Lambda.Function("Worker", {
 *   image: {
 *     uri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/worker@sha256:...",
 *     command: ["app.handler"],
 *     entryPoint: ["/lambda-entrypoint.sh"],
 *     workingDirectory: "/var/task",
 *   },
 *   architecture: "x86_64",
 * });
 * ```
 *
 * Tagged URIs are resolved through ECR on each plan. If a tag is repointed to
 * a new digest, Alchemy updates the Lambda function even though the URI string
 * is unchanged. External repositories are never modified or deleted.
 *
 * #### Build a Lambda container image
 * ```typescript
 * const func = yield* AWS.Lambda.Function("JavaFunction", {
 *   image: {
 *     context: "./lambda",
 *     dockerfile: "Dockerfile",
 *     buildArgs: {
 *       APP_ENV: "production",
 *     },
 *   },
 *   architecture: "arm64",
 *   functionUrl: false,
 * });
 * ```
 *
 * The Dockerfile owns the runtime and handler. Alchemy does not generate a
 * Node.js adapter or otherwise impose a language. For example,
 * `./lambda/Dockerfile` can use AWS's Java base image:
 *
 * ```dockerfile
 * FROM public.ecr.aws/lambda/java:21
 * COPY target/function.jar ${LAMBDA_TASK_ROOT}/lib/
 * CMD ["com.example.Handler::handleRequest"]
 * ```
 *
 * ### Effect Functions
 * Pass the Effect implementation as the third argument. Bindings
 * attach IAM permissions and environment variables at deploy time,
 * while the runtime execution context collects listeners and exports.
 *
 * **Example:** Effect Function with HTTP handler
 * ```typescript
 * export default class ApiFunction extends AWS.Lambda.Function<ApiFunction>()(
 *   "ApiFunction",
 *   { main: import.meta.url, functionUrl: true },
 *   Effect.gen(function* () {
 *     // init: bind resources
 *     const getItem = yield* AWS.DynamoDB.GetItem(table);
 *
 *     return {
 *       // runtime: use them
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const url = new URL(request.url);
 *         const id = url.searchParams.get("id");
 *         const result = yield* getItem({ Key: { pk: { S: id! } } });
 *         return yield* HttpServerResponse.json(result.Item);
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Configuration
 * **Example:** Function with URL
 * ```typescript
 * const func = yield* AWS.Lambda.Function("ApiFunction", {
 *   main: "./src/handler.ts",
 *   functionUrl: true,
 * });
 * ```
 *
 * **Example:** Function URL with IAM auth
 * ```typescript
 * const func = yield* AWS.Lambda.Function("ApiFunction", {
 *   main: "./src/handler.ts",
 *   functionUrl: {
 *     authType: "AWS_IAM",
 *   },
 * });
 * ```
 *
 * **Example:** Function in a VPC
 * ```typescript
 * const func = yield* AWS.Lambda.Function("VpcFunction", {
 *   main: "./src/handler.ts",
 *   vpc: {
 *     subnetIds: ["subnet-abc123", "subnet-def456"],
 *     securityGroupIds: ["sg-xyz789"],
 *   },
 * });
 * ```
 *
 * **Example:** Async invocation retries and failure destination
 * ```typescript
 * const func = yield* AWS.Lambda.Function("AsyncFunction", {
 *   main: "./src/handler.ts",
 *   eventInvokeConfig: {
 *     maximumRetryAttempts: 0,
 *     maximumEventAge: "1 minute",
 *     destinationConfig: {
 *       OnFailure: {
 *         Destination: queue.queueArn,
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * ### Bundling & Tree-shaking
 * `main` is bundled with rolldown at deploy time. Top-level calls in the
 * `effect`, `@effect/*`, `alchemy`, `@alchemy.run/*`, and
 * `@distilled.cloud/*` packages receive `#__PURE__` annotations by
 * default, so anything the function doesn't use from those packages is
 * tree-shaken out of the bundle. Any other package — including your own
 * app — is left untouched unless you list it explicitly.
 *
 * **Example:** Treat additional packages as pure
 * Pass package names (or picomatch globs) via `build.pure.packages` to
 * annotate them in addition to the defaults. Listing a package that also
 * declares `"sideEffects": false` (or `[]`) in its `package.json` opts it
 * into full annotation — top-level calls whose result is discarded are
 * deleted under minification when unused — so only list packages whose
 * modules really are free of meaningful top-level side effects.
 * ```typescript
 * const func = yield* AWS.Lambda.Function("ApiFunction", {
 *   main: "./src/handler.ts",
 *   build: {
 *     pure: { packages: ["my-lib", "@my-scope/*"] },
 *   },
 * });
 * ```
 *
 * **Example:** Disable pure annotations
 * ```typescript
 * const func = yield* AWS.Lambda.Function("ApiFunction", {
 *   main: "./src/handler.ts",
 *   build: { pure: false },
 * });
 * ```
 *
 * ### EFS File Systems
 * Mount an EFS access point into the function's `/mnt/…` file system. The
 * function must be attached to a VPC that can reach an EFS mount target for
 * the file system.
 *
 * **Example:** Mount an EFS access point via props
 * ```typescript
 * const accessPoint = yield* AWS.EFS.AccessPoint("FilesAccess", {
 *   fileSystemId: fileSystem.fileSystemId,
 *   posixUser: { uid: 1000, gid: 1000 },
 * });
 *
 * const func = yield* AWS.Lambda.Function("FilesFunction", {
 *   main: "./src/handler.ts",
 *   vpc: { subnetIds, securityGroupIds },
 *   fileSystemConfigs: [
 *     // pass the AccessPoint resource itself (or its ARN via `arn`)
 *     { accessPoint, localMountPath: "/mnt/files" },
 *   ],
 * });
 * ```
 *
 * **Example:** Mount via the host-agnostic EFS.mount binding
 * `EFS.mount` wires the same mount config plus least-privilege IAM through
 * the binding channel and works on both Lambda and ECS hosts.
 * ```typescript
 * export default class FilesFunction extends AWS.Lambda.Function<FilesFunction>()(
 *   "FilesFunction",
 *   { main: import.meta.url, vpc: { subnetIds, securityGroupIds } },
 *   Effect.gen(function* () {
 *     const files = yield* AWS.EFS.mount(accessPoint, { path: "/mnt/files" });
 *     return Effect.fn(function* (event: unknown) {
 *       return { mountedAt: files.path };
 *     });
 *   }).pipe(Effect.provide(AWS.EFS.MountLive)),
 * ) {}
 * ```
 *
 * ### S3 Bindings
 * Bind S3 operations in the init phase to give the function IAM
 * permissions and inject the bucket name as an environment variable.
 *
 * **Example:** Read and write S3 objects
 * ```typescript
 * // init
 * const getObject = yield* S3.GetObject(bucket);
 * const putObject = yield* S3.PutObject(bucket);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* putObject({ Key: "hello.txt", Body: "Hello!" });
 *     const obj = yield* getObject({ Key: "hello.txt" });
 *     return HttpServerResponse.text("OK");
 *   }),
 * };
 * ```
 *
 * ### DynamoDB Bindings
 * Bind DynamoDB operations in the init phase to grant table-scoped
 * IAM permissions.
 *
 * **Example:** Get and put items
 * ```typescript
 * // init
 * const getItem = yield* AWS.DynamoDB.GetItem(table);
 * const putItem = yield* AWS.DynamoDB.PutItem(table);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* putItem({ Item: { pk: { S: "user#1" }, name: { S: "Alice" } } });
 *     const result = yield* getItem({ Key: { pk: { S: "user#1" } } });
 *     return yield* HttpServerResponse.json(result.Item);
 *   }),
 * };
 * ```
 *
 * ### SQS Bindings
 * Bind SQS operations in the init phase to send messages to a queue.
 *
 * **Example:** Send a message
 * ```typescript
 * // init
 * const sendMessage = yield* SQS.SendMessage(queue);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* sendMessage({
 *       MessageBody: JSON.stringify({ orderId: "123" }),
 *     });
 *     return HttpServerResponse.text("Queued");
 *   }),
 * };
 * ```
 *
 * ### SNS Bindings
 * Bind SNS operations in the init phase to publish messages to a
 * topic.
 *
 * **Example:** Publish a notification
 * ```typescript
 * // init
 * const publish = yield* AWS.SNS.Publish(topic);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* publish({
 *       Message: JSON.stringify({ event: "order.created" }),
 *       Subject: "OrderCreated",
 *     });
 *     return HttpServerResponse.text("Published");
 *   }),
 * };
 * ```
 *
 * ### Kinesis Bindings
 * Bind Kinesis operations in the init phase to put records into a
 * stream.
 *
 * **Example:** Put a record
 * ```typescript
 * // init
 * const putRecord = yield* AWS.Kinesis.PutRecord(stream);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* putRecord({
 *       PartitionKey: "order-123",
 *       Data: new TextEncoder().encode(JSON.stringify({ orderId: "123" })),
 *     });
 *     return HttpServerResponse.text("Sent");
 *   }),
 * };
 * ```
 *
 * ### Event Sources
 * Lambda functions can be triggered by event sources like SQS queues,
 * DynamoDB streams, S3 notifications, SNS topics, and Kinesis streams.
 *
 * **Example:** Process SQS messages
 * ```typescript
 * yield* SQS.consumeQueueMessages(queue,
 *   Effect.fn(function* (message) {
 *     yield* Effect.log(`Received: ${message.body}`);
 *   }),
 * );
 * ```
 *
 * **Example:** Process DynamoDB stream changes
 * ```typescript
 * yield* AWS.DynamoDB.consumeTableChanges(table, {
 *   StreamViewType: "NEW_AND_OLD_IMAGES",
 * },
 *   Effect.fn(function* (record) {
 *     yield* Effect.log(`Change: ${record.eventName}`);
 *   }),
 * );
 * ```
 *
 * **Example:** Process S3 notifications
 * ```typescript
 * yield* AWS.S3.consumeBucketEvents(bucket, {
 *   events: ["s3:ObjectCreated:*"],
 * }, (stream) =>
 *   stream.pipe(
 *     Stream.runForEach((event) =>
 *       Effect.log(`New object: ${event.key}`),
 *     ),
 *   ),
 * );
 * ```
 *
 * @resource
 */
export const Function: Platform<
  Function,
  FunctionServices,
  FunctionShape,
  Serverless.FunctionContext,
  {},
  FunctionZipProps
> = Platform(FunctionTypeId, {
  createRuntimeContext: (id: string): Serverless.FunctionContext => {
    const listeners: Effect.Effect<Serverless.FunctionListener>[] = [];
    const env: Record<string, any> = {};

    const ctx = {
      Type: FunctionTypeId,
      id,
      env,
      set: (id: string, output: Output.Output) =>
        Effect.sync(() => {
          // Key is already canonical (see RuntimeContext.sanitizeKey); store it
          // verbatim. `packEnvValue` marker-packs Redacted values so they
          // survive the Output → Lambda env var round-trip.
          const key = id;
          env[key] = output.pipe(Output.map(packEnvValue));
          return key;
        }),
      get: <T>(key: string) =>
        // Key is already canonical (see RuntimeContext.sanitizeKey). Read
        // straight from `process.env` — see `unpackEnvValue` for why this
        // must never resolve through `Config.string`.
        Effect.sync(() => unpackEnvValue<T>(process.env[key])),
      serve: (handler: HttpEffect) =>
        // @ts-ignore
        ctx.listen(makeFunctionHttpHandler(handler)),
      listen: ((
        handler:
          | Serverless.FunctionListener
          | Effect.Effect<Serverless.FunctionListener>,
      ) =>
        Effect.sync(() =>
          Effect.isEffect(handler)
            ? listeners.push(handler)
            : listeners.push(Effect.succeed(handler)),
        )) as any as Serverless.FunctionContext["listen"],
      exports: Effect.sync(() => ({
        // construct an Effect that produces the Function's entrypoint
        // Effect<(event, context) => Promise<any>>
        handler: Effect.gen(function* () {
          const handlers = yield* Effect.all(listeners, {
            concurrency: "unbounded",
          });
          // Sandbox-lifetime services, captured so each invocation can
          // build its telemetry exporters and run the handler effect
          // against the same context the init phase saw (mirrors
          // WorkerBridge). The build's memo map is stripped so a Layer the
          // user `Effect.provide`s inside a handler builds per invocation.
          const services = Context.omit(Layer.CurrentMemoMap)(
            yield* Effect.context<never>(),
          );
          return async (event: any, context: lambda.Context): Promise<any> => {
            for (const handler of handlers) {
              const eff = handler(event);
              if (Effect.isEffect(eff)) {
                // Each invocation gets a fresh request scope, matching the
                // Worker / Durable Object / Workflow bridges. The scope is
                // settled inline before returning: a buffered Lambda
                // response is not released to the caller until the Invoke
                // phase completes, so deferring cleanup (e.g. via an
                // INVOKE-subscribed extension window) shows up as response
                // latency anyway — keep request finalizers fast. A failing
                // finalizer is logged and ignored so it can't mask the
                // invocation's outcome.
                const scope = Scope.makeUnsafe();
                const exit = await eff.pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      Layer.succeed(HandlerContext, context),
                      Layer.succeed(Scope.Scope, scope),
                      // The configured telemetry exporters, attached to the
                      // invocation scope by `buildEventTelemetry` so
                      // buffered spans/logs/metrics flush when it settles
                      // below.
                      Layer.effectContext(
                        buildEventTelemetry(
                          services,
                          scope,
                          (ctx as Serverless.FunctionContext).telemetry,
                        ),
                      ),
                    ).pipe(Layer.provideMerge(Layer.succeedContext(services))),
                  ),
                  Effect.tap(Effect.logDebug),
                  Effect.runPromiseExit,
                );
                if (!isScopeEjected(scope)) {
                  // The HttpMiddleware tracer ends the request's root span
                  // in a dispatcher task scheduled after the handler effect
                  // resolves; yield one macrotask so it reaches the
                  // telemetry exporter's buffer before the flush finalizer.
                  await new Promise((resolve) => setTimeout(resolve, 0));
                  await Scope.close(scope, exit).pipe(
                    Effect.ignoreCause({
                      log: "Warn",
                      message: "Lambda invocation scope close failed",
                    }),
                    Effect.runPromise,
                  );
                }
                if (Exit.isSuccess(exit)) {
                  return exit.value;
                }
                throw Cause.squash(exit.cause);
              }
            }
            throw new Error("No event handler found");
          };
        }),
      })),
    };
    return ctx;
  },
});

export const FunctionProvider = () =>
  Provider.effect(
    Function,
    Effect.gen(function* () {
      const stack = yield* Stack;

      // Code bundling lives in FunctionBundle.ts so the floci local
      // provider's watch loop can rebuild the identical artifact.
      const { bundleCode } = yield* makeFunctionBundler;
      const functionImage = yield* makeFunctionImage;
      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
      };

      const createFunctionName = (
        id: string,
        functionName: string | undefined,
      ) =>
        Effect.gen(function* () {
          return (
            functionName ?? (yield* createPhysicalName({ id, maxLength: 64 }))
          );
        });

      const createRoleName = (id: string) =>
        createPhysicalName({ id, maxLength: 64 });

      const createPolicyName = (id: string) =>
        createPhysicalName({ id, maxLength: 128 });

      const hashBundle = (code: Uint8Array<ArrayBufferLike>) => sha256(code);

      const createNames = (id: string, functionName: string | undefined) =>
        Effect.gen(function* () {
          const { accountId, region } = yield* AWSEnvironment.current;
          const roleName = yield* createRoleName(id);
          const policyName = yield* createPolicyName(id);
          const fn = yield* createFunctionName(id, functionName);
          return {
            roleName,
            policyName,
            functionName: fn,
            roleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
            functionArn: `arn:aws:lambda:${region}:${accountId}:function:${fn}`,
          };
        });

      const attachBindings = Effect.fn(function* ({
        roleName,
        policyName,
        // functionArn,
        // functionName,
        bindings,
      }: {
        roleName: string;
        policyName: string;
        functionArn: string;
        functionName: string;
        bindings: ResourceBinding<Function["Binding"]>[];
      }) {
        const activeBindings = bindings.filter(
          (
            binding: ResourceBinding<Function["Binding"]> & { action?: string },
          ) => binding.action !== "delete",
        );
        const env = activeBindings
          .map((binding) => binding?.data?.env)
          .reduce((acc, env) => ({ ...acc, ...env }), {});
        const policyStatements = activeBindings.flatMap(
          (binding) =>
            binding?.data?.policyStatements?.map(
              (stmt: IAM.PolicyStatement) => ({
                ...stmt,
                Sid: stmt.Sid?.replace(/[^A-Za-z0-9]+/gi, ""),
              }),
            ) ?? [],
        );
        // VPC attachments requested through the binding channel (DECISION
        // #5) — set-union across bindings; merged with the `vpc` prop in
        // `reconcile`.
        const vpcRequests = activeBindings.flatMap((binding) =>
          binding?.data?.vpc ? [binding.data.vpc] : [],
        );
        const vpc =
          vpcRequests.length > 0
            ? {
                subnetIds: [
                  ...new Set(vpcRequests.flatMap((v) => v.subnetIds)),
                ],
                securityGroupIds: [
                  ...new Set(vpcRequests.flatMap((v) => v.securityGroupIds)),
                ],
              }
            : undefined;
        // EFS mounts requested through the binding channel (`EFS.Mount`) —
        // deduped by mount path; merged with the `fileSystemConfigs` prop in
        // `reconcile`.
        const fileSystemConfigs = [
          ...new Map(
            activeBindings
              .flatMap((binding) => binding?.data?.fileSystemConfigs ?? [])
              .map((config) => [config.localMountPath, config] as const),
          ).values(),
        ];

        if (policyStatements.length > 0) {
          yield* iam.putRolePolicy({
            RoleName: roleName,
            PolicyName: policyName,
            PolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: policyStatements,
            } satisfies IAM.PolicyDocument),
          });
        } else {
          yield* iam
            .deleteRolePolicy({
              RoleName: roleName,
              PolicyName: policyName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }

        return { env, vpc, fileSystemConfigs };
      });

      const xrayWriteAccessPolicyArn =
        "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess";

      /**
       * Converge the X-Ray write managed policy on the execution role with
       * the desired tracing mode. Attaching is idempotent; detaching is only
       * attempted when the previous state may have had it attached (routine
       * update from `Active`, or adoption where the prior props are unknown)
       * to avoid a wasted IAM call on every deploy.
       */
      const syncTracingPolicy = Effect.fn(function* ({
        roleName,
        tracing,
        mayHaveBeenActive,
      }: {
        roleName: string;
        tracing: FunctionProps["tracing"];
        mayHaveBeenActive: boolean;
      }) {
        if (tracing === "Active") {
          yield* iam.attachRolePolicy({
            RoleName: roleName,
            PolicyArn: xrayWriteAccessPolicyArn,
          });
        } else if (mayHaveBeenActive) {
          yield* iam
            .detachRolePolicy({
              RoleName: roleName,
              PolicyArn: xrayWriteAccessPolicyArn,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }
      });

      const createRoleIfNotExists = Effect.fn(function* ({
        id,
        roleName,
        vpc,
      }: {
        id: string;
        roleName: string;
        vpc?: FunctionProps["vpc"];
      }) {
        yield* Effect.logDebug(`creating role ${id}`);
        const tags = yield* createInternalTags(id);
        // Observe before ensure. Reconcile calls this even with persisted
        // output so an execution role deleted out-of-band is recreated, but
        // the normal update path avoids provoking an expected
        // EntityAlreadyExists exception (important under high concurrency).
        let role = yield* iam
          .getRole({ RoleName: roleName })
          .pipe(
            Effect.catchTag("NoSuchEntityException", () =>
              Effect.succeed(undefined),
            ),
          );
        if (role === undefined) {
          // Engine has cleared us via `read` — foreign-tagged functions are
          // surfaced as `Unowned` and require `--adopt`. On a race between
          // observe and create, read the role created by the peer reconciler.
          role = yield* iam
            .createRole({
              RoleName: roleName,
              AssumeRolePolicyDocument: JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: {
                      Service: "lambda.amazonaws.com",
                    },
                    Action: "sts:AssumeRole",
                  },
                ],
              }),
              Tags: createTagsList(tags),
            })
            .pipe(
              Effect.catchTag("EntityAlreadyExistsException", () =>
                iam.getRole({ RoleName: roleName }),
              ),
            );
        }

        yield* Effect.logDebug(`attaching policy ${id}`);
        yield* iam
          .attachRolePolicy({
            RoleName: roleName,
            PolicyArn:
              "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          })
          .pipe(Effect.tapError(Effect.logDebug), Effect.tap(Effect.logDebug));

        if (vpc) {
          yield* iam
            .attachRolePolicy({
              RoleName: roleName,
              PolicyArn:
                "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
            })
            .pipe(
              Effect.tapError(Effect.logDebug),
              Effect.tap(Effect.logDebug),
            );
        }

        yield* Effect.logDebug(`attached policy ${id}`);
        return role;
      });

      const withNodeSourceMaps = (
        env: Record<string, string> | undefined,
        props: FunctionZipProps,
      ) => {
        const sourcemap = props.build?.output?.sourcemap ?? true;
        const uploadSourceMap = props.uploadSourceMap ?? true;
        const shouldEnableSourceMaps =
          sourcemap === "inline" ||
          (uploadSourceMap && (sourcemap === true || sourcemap === "hidden"));

        if (!shouldEnableSourceMaps) {
          return env;
        }

        const current = env?.NODE_OPTIONS;
        if (current?.split(/\s+/).includes("--enable-source-maps")) {
          return env;
        }

        return {
          ...env,
          NODE_OPTIONS: current
            ? `${current} --enable-source-maps`
            : "--enable-source-maps",
        };
      };

      const retryFunctionMutation = Effect.retry({
        while: (e: any) =>
          e._tag === "ResourceConflictException" ||
          e._tag === "TooManyRequestsException",
        schedule: Schedule.max([
          Schedule.exponential(100),
          Schedule.recurs(30),
        ]),
      }) as <A, R, Err>(
        self: Effect.Effect<A, Err, R>,
      ) => Effect.Effect<A, Err, R>;

      const waitForFunctionUpdate = Effect.fn(function* (
        functionName: string,
        session: { note: (note: string) => Effect.Effect<void> },
      ) {
        return yield* Effect.gen(function* () {
          const configuration = (yield* Lambda.getFunction({
            FunctionName: functionName,
          })).Configuration;
          if (
            configuration?.State === "Failed" ||
            configuration?.LastUpdateStatus === "Failed"
          ) {
            return yield* new FunctionUpdateFailed({
              functionName,
              reason:
                configuration.LastUpdateStatusReason ??
                configuration.StateReason,
            });
          }
          if (
            configuration?.State === "Active" &&
            (configuration.LastUpdateStatus === undefined ||
              configuration.LastUpdateStatus === "Successful")
          ) {
            return;
          }
          return yield* new FunctionUpdatePending({ functionName });
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "FunctionUpdatePending",
            schedule: Schedule.spaced("2 seconds").pipe(
              Schedule.tap(({ attempt }) =>
                session.note(
                  `Waiting for Lambda image update before repository cleanup: ${functionName} (${attempt * 2}s)`,
                ),
              ),
            ),
            times: 30,
          }),
        );
      });

      const getReservedConcurrentExecutions = Effect.fn(function* (
        functionName: string,
      ) {
        return yield* Lambda.getFunctionConcurrency({
          FunctionName: functionName,
        }).pipe(
          Effect.map((config) => config.ReservedConcurrentExecutions),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const syncReservedConcurrentExecutions = Effect.fn(function* ({
        functionName,
        reservedConcurrentExecutions,
      }: {
        functionName: string;
        reservedConcurrentExecutions: number | undefined;
      }) {
        const current = yield* getReservedConcurrentExecutions(functionName);
        if (current === reservedConcurrentExecutions) {
          return current;
        }

        if (reservedConcurrentExecutions === undefined) {
          yield* Lambda.deleteFunctionConcurrency({
            FunctionName: functionName,
          }).pipe(
            retryFunctionMutation,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          return undefined;
        }

        const updated = yield* Lambda.putFunctionConcurrency({
          FunctionName: functionName,
          ReservedConcurrentExecutions: reservedConcurrentExecutions,
        }).pipe(retryFunctionMutation);
        return (
          updated.ReservedConcurrentExecutions ?? reservedConcurrentExecutions
        );
      });

      type FunctionDeploymentCode =
        | {
            packageType: "Zip";
            archive: Uint8Array<ArrayBufferLike>;
            hash: string;
          }
        | {
            packageType: "Image";
            imageUri: string;
            hash: string;
          };

      interface PreparedFunctionCode {
        deployment: FunctionDeploymentCode;
        attributes: Function["Attributes"]["code"];
      }

      const prepareImageFunctionCode = Effect.fn(function* ({
        id,
        props,
        previousImage,
        session,
      }: {
        id: string;
        props: FunctionImageProps;
        previousImage?: Omit<FunctionImageAttributes, "hash">;
        session: { note: (note: string) => Effect.Effect<void> };
      }) {
        const { hash, ...image } = yield* functionImage.resolve({
          id,
          source: props.image,
          architecture: props.architecture,
          previousImage,
          session,
        });
        return {
          deployment: {
            packageType: "Image",
            imageUri: image.imageUri,
            hash,
          },
          attributes: { hash, image },
        } satisfies PreparedFunctionCode;
      });

      const preparePrecreatedFunctionCode = Effect.fn(function* ({
        id,
        props,
        session,
      }: {
        id: string;
        props: FunctionProps;
        session: { note: (note: string) => Effect.Effect<void> };
      }) {
        if (isFunctionImageProps(props)) {
          return yield* prepareImageFunctionCode({ id, props, session });
        }

        // Mock code for the pre-created stub. It responds 503 (rather than a
        // bare 200) so that, during the brief window where the real code/config
        // update is still `InProgress`, a Function URL hit serves an honest
        // "not ready" signal. Downstream readiness probes already retry on
        // non-200, so they wait for the real handler without blocking the
        // provider.
        const code = new TextEncoder().encode(
          `export default () => ({ statusCode: 503, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "function initializing" }) })`,
        );
        const archive = yield* zipCode(code);
        const hash = yield* hashBundle(code);
        return {
          deployment: {
            packageType: "Zip",
            archive,
            hash,
          },
          attributes: { hash },
        } satisfies PreparedFunctionCode;
      });

      const prepareFunctionCode = Effect.fn(function* ({
        id,
        props,
        previousImage,
        session,
      }: {
        id: string;
        props: FunctionProps;
        previousImage?: Omit<FunctionImageAttributes, "hash">;
        session: { note: (note: string) => Effect.Effect<void> };
      }) {
        if (isFunctionImageProps(props)) {
          return yield* prepareImageFunctionCode({
            id,
            props,
            previousImage,
            session,
          });
        }

        const { identityHash, buildArchive } = yield* bundleCode(id, props);
        const { archive, archiveHash } = yield* buildArchive;
        return {
          deployment: {
            packageType: "Zip",
            archive,
            hash: archiveHash,
          },
          attributes: { hash: identityHash },
        } satisfies PreparedFunctionCode;
      });

      const createOrUpdateFunction: (input: {
        id: string;
        news: FunctionProps;
        roleArn: string;
        code: FunctionDeploymentCode;
        env: Record<string, string> | undefined;
        functionName: string;
        preferUpdate?: boolean;
        // Resolved EFS mounts. `undefined` leaves the function's existing
        // config untouched (precreate stub); `[]` explicitly clears mounts.
        fileSystemConfigs?: Lambda.FileSystemConfig[];
        // Effective VPC attachment (prop ∪ binding-channel requests).
        // Omitted for the precreate stub: `news` is UNRESOLVED at precreate
        // (Output-valued subnet/security-group ids would fail to serialize),
        // and the stub doesn't need connectivity — `reconcile` attaches the
        // resolved VPC config afterwards.
        vpc?: FunctionProps["vpc"];
        session: { note: (note: string) => Effect.Effect<void> };
      }) => Effect.Effect<
        void,
        any,
        Credentials | Region | HttpClient | Stack | Stage | AWSEnvironment
      > = Effect.fn(function* ({
        id,
        news,
        roleArn,
        code,
        env,
        functionName,
        preferUpdate,
        fileSystemConfigs,
        vpc,
        session,
      }: {
        id: string;
        news: FunctionProps;
        roleArn: string;
        code: FunctionDeploymentCode;
        env: Record<string, string> | undefined;
        functionName: string;
        preferUpdate?: boolean;
        fileSystemConfigs?: Lambda.FileSystemConfig[];
        vpc?: FunctionProps["vpc"];
        session: { note: (note: string) => Effect.Effect<void> };
      }) {
        yield* Effect.logDebug(`creating function ${id}`);
        const waitStartedAt = Date.now();

        const isRolePropagationError = <
          E extends Lambda.UpdateFunctionCodeError | Lambda.CreateFunctionError,
        >(
          e: E,
        ) =>
          e._tag === "InvalidParameterValueException" &&
          (e.message?.includes("cannot be assumed by Lambda") ||
            // Freshly attached AWSLambdaVPCAccessExecutionRole still
            // propagating when a VPC-attached function is created/updated.
            e.message?.includes(
              "does not have permissions to call CreateNetworkInterface",
            ) ||
            (e.message?.includes("KMS key is invalid for CreateGrant") &&
              e.message?.includes("ARN does not refer to a valid principal")));

        const noteRolePropagationWait = () =>
          session.note(
            `Waiting for Lambda execution role to become assumable: ${functionName} (${Math.ceil((Date.now() - waitStartedAt) / 1000)}s)`,
          );

        const tags = yield* createInternalTags(id);

        const codeLocation = yield* Effect.gen(function* () {
          if (code.packageType === "Image") {
            return { ImageUri: code.imageUri } as const;
          }
          // Try to use S3 if the assets bucket is available, otherwise fall
          // back to an inline ZipFile.
          const assets = (yield* Effect.serviceOption(Assets)).pipe(
            Option.getOrUndefined,
          );
          if (!assets) {
            return { ZipFile: code.archive } as const;
          }
          const key = yield* assets.uploadAsset(code.hash, code.archive);
          yield* Effect.logDebug(
            `Using S3 for code: s3://${yield* assets.bucketName}/${key}`,
          );
          return {
            S3Bucket: yield* assets.bucketName,
            S3Key: key,
          } as const;
        });
        const runtimeEnv = isFunctionImageProps(news)
          ? env
          : withNodeSourceMaps(env, news);

        const createFunctionRequest: CreateFunctionRequest = {
          FunctionName: functionName,
          Role: roleArn,
          Code: codeLocation,
          ...(isFunctionImageProps(news)
            ? {
                PackageType: "Image" as const,
                ImageConfig: toLambdaImageConfig(news.image),
              }
            : {
                // Effect-mode functions are wrapped in a generated entry whose
                // ONLY export is `default` — `handler` names an export of the
                // USER's module and can only address it when the module is
                // bundled as-is (isExternal). Honoring it in Effect mode
                // deploys a Lambda that dies at init with
                // Runtime.HandlerNotFound.
                Handler: handlerStringOf(news),
                Runtime: news.runtime ?? "nodejs24.x",
                PackageType: "Zip" as const,
              }),
          Architectures: [news.architecture ?? "x86_64"],
          MemorySize: news.memorySize,
          // Always explicit: `UpdateFunctionConfiguration` treats an omitted
          // `Layers` as "leave as-is", so removing the prop would strand the
          // previously-attached layers.
          Layers: isFunctionImageProps(news)
            ? undefined
            : (news.layers ?? []).map(layerVersionArnOf),
          Environment: runtimeEnv
            ? {
                Variables: {
                  ...runtimeEnv,
                  ...alchemyEnv,
                },
              }
            : undefined,
          Tags: tags,
          Timeout: toTimeoutSeconds(news.timeout),
          // Always explicit so removing the `tracing` prop converges back to
          // the AWS default on update.
          TracingConfig: { Mode: news.tracing ?? "PassThrough" },
          // Durability is create-time-only; a presence flip is a replacement
          // (see `diff`), so passing the same value on update is a no-op.
          DurableConfig: news.durableConfig,
          VpcConfig: vpc
            ? {
                SubnetIds: vpc.subnetIds,
                SecurityGroupIds: vpc.securityGroupIds,
              }
            : undefined,
          FileSystemConfigs: fileSystemConfigs,
        };

        const getAndUpdate = Lambda.getFunction({
          FunctionName: functionName,
        }).pipe(
          // If it exists and contains these tags, we will assume it was created
          // by alchemy but state was lost, so if it exists, let's adopt it.
          // Some backends (e.g. local emulators) omit `Tags` on GetFunction —
          // fall back to ListTags before concluding the function is foreign.
          Effect.flatMap((f) =>
            f.Tags !== undefined
              ? Effect.succeed(hasTags(tags, f.Tags))
              : Lambda.listTags({
                  Resource: f.Configuration?.FunctionArn ?? "",
                }).pipe(
                  Effect.map((r) => hasTags(tags, r.Tags ?? {})),
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(false),
                  ),
                ),
          ),
          Effect.filterOrFail(
            (owned) => owned,
            () =>
              // TODO(sam): add custom
              new Error("Function tags do not match expected values"),
          ),
          Effect.flatMap(() =>
            Effect.gen(function* () {
              yield* Effect.logDebug(`updating function code ${id}`);
              yield* Lambda.updateFunctionCode({
                FunctionName: createFunctionRequest.FunctionName,
                Architectures: createFunctionRequest.Architectures,
                ...codeLocation,
              }).pipe(
                Effect.tapError((e) =>
                  isRolePropagationError(e)
                    ? noteRolePropagationWait()
                    : Effect.void,
                ),
                Effect.retry({
                  while: (e) =>
                    e._tag === "ResourceConflictException" ||
                    isRolePropagationError(e),
                  schedule: Schedule.exponential(100),
                }),
              );
              yield* Effect.logDebug(`updated function code ${id}`);
              yield* Lambda.updateFunctionConfiguration({
                FunctionName: createFunctionRequest.FunctionName,
                DeadLetterConfig: createFunctionRequest.DeadLetterConfig,
                Description: createFunctionRequest.Description,
                Environment: createFunctionRequest.Environment,
                EphemeralStorage: createFunctionRequest.EphemeralStorage,
                FileSystemConfigs: createFunctionRequest.FileSystemConfigs,
                Handler: createFunctionRequest.Handler,
                ImageConfig: imageConfigForUpdate(news),
                KMSKeyArn: createFunctionRequest.KMSKeyArn,
                Layers: createFunctionRequest.Layers,
                LoggingConfig: createFunctionRequest.LoggingConfig,
                MemorySize: createFunctionRequest.MemorySize,
                // RevisionId: "???"
                Role: createFunctionRequest.Role,
                Runtime: createFunctionRequest.Runtime,
                SnapStart: createFunctionRequest.SnapStart,
                Timeout: createFunctionRequest.Timeout,
                TracingConfig: createFunctionRequest.TracingConfig,
                VpcConfig: createFunctionRequest.VpcConfig,
                DurableConfig: createFunctionRequest.DurableConfig,
              }).pipe(
                Effect.tapError((e) =>
                  isRolePropagationError(e)
                    ? noteRolePropagationWait()
                    : Effect.void,
                ),
                Effect.retry({
                  while: (e) =>
                    e._tag === "ResourceConflictException" ||
                    isRolePropagationError(e),
                  schedule: Schedule.exponential(100),
                }),
              );
              yield* Effect.logDebug(`updated function configuration ${id}`);
            }),
          ),
        ) as Effect.Effect<any, any, Credentials | Region | HttpClient>;

        const create = Lambda.createFunction(createFunctionRequest).pipe(
          Effect.tapError((e) =>
            Effect.gen(function* () {
              yield* Effect.logDebug(e);
            }),
          ),
          Effect.retry({
            while: (e) => isRolePropagationError(e),
            schedule: Schedule.fixed(1000).pipe(
              Schedule.tap(() => noteRolePropagationWait()),
            ),
          }),
          Effect.catchTags({
            ResourceConflictException: () => getAndUpdate,
          }),
        ) as Effect.Effect<any, any, Credentials | Region | HttpClient>;

        if (preferUpdate) {
          yield* getAndUpdate.pipe(
            Effect.catchTags({
              ResourceNotFoundException: () => create,
            }),
          );
        } else {
          yield* create;
        }
      });

      const publicUrlAccessStatementId = "FunctionURLAllowPublicAccess";
      const publicUrlInvokeStatementId = "FunctionURLAllowPublicInvoke";

      const removePublicFunctionUrlPermissions = Effect.fn(function* (
        functionName: string,
      ) {
        yield* Effect.all(
          [
            Lambda.removePermission({
              FunctionName: functionName,
              StatementId: publicUrlAccessStatementId,
            }).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            ),
            Lambda.removePermission({
              FunctionName: functionName,
              StatementId: publicUrlInvokeStatementId,
            }).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            ),
          ],
          { concurrency: "unbounded" },
        );
      });

      const upsertPermission = (permission: Lambda.AddPermissionRequest) =>
        Lambda.addPermission(permission).pipe(
          Effect.catchTag("ResourceConflictException", () =>
            Effect.gen(function* () {
              yield* Lambda.removePermission({
                FunctionName: permission.FunctionName,
                StatementId: permission.StatementId,
              }).pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
              yield* Lambda.addPermission(permission);
            }),
          ),
          retryFunctionMutation,
        );

      const upsertPublicFunctionUrlPermissions = Effect.fn(function* (
        functionName: string,
      ) {
        yield* Effect.all(
          [
            upsertPermission({
              FunctionName: functionName,
              StatementId: publicUrlAccessStatementId,
              Action: "lambda:InvokeFunctionUrl",
              Principal: "*",
              FunctionUrlAuthType: "NONE",
            }),
            upsertPermission({
              FunctionName: functionName,
              StatementId: publicUrlInvokeStatementId,
              Action: "lambda:InvokeFunction",
              Principal: "*",
              InvokedViaFunctionUrl: true,
            }),
          ],
          { concurrency: "unbounded" },
        );
      });

      const createOrUpdateFunctionUrl = Effect.fn(function* ({
        functionName,
        url,
        oldUrl,
        currentFunctionUrl,
      }: {
        functionName: string;
        url: FunctionProps["functionUrl"];
        oldUrl?: FunctionProps["functionUrl"];
        currentFunctionUrl?: string;
      }) {
        const desired = normalizeFunctionUrl(url);
        const previous = normalizeFunctionUrl(oldUrl);
        const hadFunctionUrl = previous !== undefined || !!currentFunctionUrl;

        if (desired) {
          yield* Effect.logDebug(
            `creating function url config ${functionName}`,
          );
          const shouldClearCors =
            desired.cors === undefined && previous?.cors !== undefined;
          const config = {
            FunctionName: functionName,
            AuthType: desired.authType,
            Cors: desired.cors ?? (shouldClearCors ? {} : undefined),
            InvokeMode: desired.invokeMode,
          } satisfies
            | Lambda.CreateFunctionUrlConfigRequest
            | Lambda.UpdateFunctionUrlConfigRequest;
          const { FunctionUrl } = yield* Lambda.createFunctionUrlConfig(
            config,
          ).pipe(
            Effect.catchTag("ResourceConflictException", () =>
              Lambda.updateFunctionUrlConfig(config),
            ),
            retryFunctionMutation,
          );

          if (desired.authType === "NONE") {
            yield* upsertPublicFunctionUrlPermissions(functionName);
          } else {
            yield* removePublicFunctionUrlPermissions(functionName);
          }

          yield* Effect.logDebug(`created function url config ${functionName}`);
          return FunctionUrl;
        } else if (hadFunctionUrl) {
          yield* Effect.logDebug(
            `deleting function url config ${functionName}`,
          );
          yield* Effect.all([
            Lambda.deleteFunctionUrlConfig({
              FunctionName: functionName,
            }).pipe(
              retryFunctionMutation,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            ),
            removePublicFunctionUrlPermissions(functionName),
          ]);
          yield* Effect.logDebug(`deleted function url config ${functionName}`);
        }
        return undefined;
      });

      const summary = (code: FunctionDeploymentCode) =>
        code.packageType === "Image"
          ? code.imageUri
          : code.archive.length >= 1024 * 1024
            ? `${(code.archive.length / (1024 * 1024)).toFixed(2)}MB`
            : code.archive.length >= 1024
              ? `${(code.archive.length / 1024).toFixed(2)}KB`
              : `${code.archive.length}B`;

      const refreshPersistedFunctionCode = ({
        output,
        packageType,
        observed,
      }: {
        output: Function["Attributes"] | undefined;
        packageType: Lambda.PackageType | undefined;
        observed:
          | {
              ImageUri?: string;
              ResolvedImageUri?: string;
            }
          | undefined;
      }): Function["Attributes"]["code"] => {
        if (output?.code === undefined) {
          // Cold adoption has no persisted source hash. Return a complete
          // Attributes shape and let the forced post-adoption reconcile write
          // the desired code and replace this placeholder.
          return { hash: "" };
        }
        if (packageType !== "Image" || output.code.image === undefined) {
          return output.code;
        }

        // Lambda can refresh the deployed URI and digest, but it cannot
        // reconstruct Alchemy's source hash or prove repository ownership.
        // Preserve that metadata from state instead of inferring a managed
        // repository from an arbitrary image during adoption.
        const resolvedImageUri = observed?.ResolvedImageUri;
        const digest = resolvedImageUri?.split("@").at(-1);
        return {
          ...output.code,
          image: {
            ...output.code.image,
            ...(observed?.ImageUri === undefined
              ? {}
              : { imageUri: observed.ImageUri }),
            ...(resolvedImageUri === undefined ? {} : { resolvedImageUri }),
            ...(digest === undefined ? {} : { digest }),
          },
        };
      };

      return {
        stables: ["functionArn", "functionName", "roleName"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return;
          yield* validateFunctionPackageProps(id, news);
          if (isFunctionImageProps(news)) {
            yield* decodeFunctionImageSource(id, news.image);
          }
          // If output is undefined (resource in creating state), defer to default diff
          if (!output) {
            return undefined;
          }
          // Auto-generated names are engine-owned: the deployed name stays
          // authoritative even if the generator would name this id
          // differently today. Only an explicit user-provided functionName
          // can force a replace.
          const newFunctionName = news.functionName ?? output.functionName;
          if (output.functionName !== newFunctionName) {
            // The new physical name differs from the deployed name, so it can
            // be created before dependents switch over and the old function is
            // deleted. delete-first is only needed by replacements that reuse
            // the same explicit name below.
            return { action: "replace" };
          }
          if (isFunctionImageProps(olds) !== isFunctionImageProps(news)) {
            return {
              action: "replace",
              deleteFirst: news.functionName !== undefined,
            };
          }
          if (
            !isFunctionImageProps(olds) &&
            !isFunctionImageProps(news) &&
            !!olds.durableConfig !== !!news.durableConfig
          ) {
            // DurableConfig can only be enabled/disabled at CreateFunction —
            // switching a logical id between Function and DurableFunction (or
            // vice versa) must replace the physical function.
            return {
              action: "replace",
              deleteFirst: news.functionName !== undefined,
            };
          }
          if (
            !deepEqual(
              normalizeFunctionUrl(olds.functionUrl),
              normalizeFunctionUrl(news.functionUrl),
            )
          ) {
            return { action: "update" };
          }
          let imageIdentity: FunctionImageIdentity | undefined;
          let codeHash: string;
          if (isFunctionImageProps(news)) {
            imageIdentity = yield* functionImage.identity(
              id,
              news.image,
              news.architecture,
            );
            codeHash = imageIdentity.hash;
          } else {
            codeHash = (yield* bundleCode(id, news)).identityHash;
          }
          if (output.code.hash !== codeHash) {
            // code changed
            return { action: "update" };
          }
          if (isFunctionImageProps(news)) {
            const image = output.code.image;
            if (
              image === undefined ||
              image.source !== imageIdentity?.source ||
              (imageIdentity?.source === "uri"
                ? image.imageUri !== imageIdentity.imageUri ||
                  image.resolvedImageUri !== imageIdentity.resolvedImageUri
                : image.imageUri !== `${image.repositoryUri}:${codeHash}` ||
                  !(yield* functionImage.isReady(
                    id,
                    image.repositoryName,
                    codeHash,
                  )))
            ) {
              return { action: "update" };
            }
            if (
              isFunctionImageProps(olds) &&
              !deepEqual(
                toLambdaImageConfig(olds.image),
                toLambdaImageConfig(news.image),
              )
            ) {
              return { action: "update" };
            }
          }
          if (
            toTimeoutSeconds(olds.timeout) !== toTimeoutSeconds(news.timeout)
          ) {
            return { action: "update" };
          }
          if (olds.architecture !== news.architecture) {
            return { action: "update" };
          }
          if (
            olds.reservedConcurrentExecutions !==
            news.reservedConcurrentExecutions
          ) {
            return { action: "update" };
          }
          // `layers` accepts a LayerVersion resource or a raw ARN, and the
          // two forms are structurally different props even when they name
          // the same layer. Compare them normalized so switching between the
          // forms isn't a phantom change; everything else still falls through
          // to the engine's default props comparison.
          const normalizeLayers = (props: FunctionProps) => ({
            ...props,
            layers: (props.layers ?? []).map(layerVersionArnOf),
          });
          if (!havePropsChanged(normalizeLayers(olds), normalizeLayers(news))) {
            return { action: "noop" };
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const functionName =
            output?.functionName ??
            (yield* createFunctionName(id, olds?.functionName));
          yield* Effect.logDebug(`reading function ${functionName}`);
          const result = yield* Lambda.getFunction({
            FunctionName: functionName,
          }).pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
          const fn = result?.Configuration;
          if (!fn?.FunctionArn || !fn.FunctionName || !fn.Role) {
            return undefined;
          }
          const tagsResult = yield* Lambda.listTags({
            Resource: fn.FunctionArn,
          }).pipe(
            Effect.map((r) => r.Tags ?? {}),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({} as Record<string, string>),
            ),
          );
          const functionUrl = yield* Lambda.getFunctionUrlConfig({
            FunctionName: fn.FunctionName,
          }).pipe(
            Effect.map((f) => f.FunctionUrl),
            Effect.retry({
              while: (e: any) => e._tag === "ResourceConflictException",
              schedule: Schedule.exponential(100),
            }),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
          const reservedConcurrentExecutions =
            yield* getReservedConcurrentExecutions(fn.FunctionName);
          // Reuse the persisted output where we have it (e.g. code hash) so
          // diff doesn't see drift it can't reconstruct from the API.
          const attrs = {
            ...output,
            functionArn: fn.FunctionArn,
            functionName: fn.FunctionName,
            functionUrl,
            roleArn: fn.Role,
            roleName: output?.roleName ?? fn.Role.split("/").pop()!,
            code: refreshPersistedFunctionCode({
              output,
              packageType: fn.PackageType,
              observed: result?.Code,
            }),
            reservedConcurrentExecutions,
          } satisfies Function["Attributes"];
          return (yield* hasAlchemyTags(id, tagsResult))
            ? attrs
            : Unowned(attrs);
        }),
        // Account/region collection: exhaustively paginate `listFunctions`
        // (its `Functions` items are `FunctionConfiguration`s, the same shape
        // `read` pulls from `getFunction().Configuration`), then hydrate each
        // into the exact `read` Attributes shape with a bounded fan-out. The
        // code hash is not recoverable from the API (it lives in persisted
        // state), so it is left empty — `delete`/nuke only needs the
        // function/role identifiers.
        list: () =>
          Effect.gen(function* () {
            const configs = yield* Lambda.listFunctions.items({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
            const rows = yield* Effect.forEach(
              configs,
              (fn) =>
                Effect.gen(function* () {
                  if (!fn.FunctionArn || !fn.FunctionName || !fn.Role) {
                    return undefined;
                  }
                  const functionUrl = yield* Lambda.getFunctionUrlConfig({
                    FunctionName: fn.FunctionName,
                  }).pipe(
                    Effect.map((f) => f.FunctionUrl),
                    // No URL config (or the function vanished between the
                    // list and the hydrate) — surface `undefined`, matching
                    // `read`.
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  );
                  const reservedConcurrentExecutions =
                    yield* getReservedConcurrentExecutions(fn.FunctionName);
                  return {
                    functionArn: fn.FunctionArn,
                    functionName: fn.FunctionName,
                    functionUrl,
                    roleArn: fn.Role,
                    roleName: fn.Role.split("/").pop()!,
                    code: { hash: "" },
                    ...(reservedConcurrentExecutions === undefined
                      ? {}
                      : { reservedConcurrentExecutions }),
                  } satisfies Function["Attributes"];
                }),
              { concurrency: 10 },
            );
            return rows.filter(
              (row): row is Function["Attributes"] => row !== undefined,
            );
          }),

        precreate: Effect.fn(function* ({ id, news, session }) {
          yield* validateFunctionPackageProps(id, news);
          if (isFunctionImageProps(news)) {
            // Resolve and validate the image before creating the execution
            // role. External references perform only ECR reads here; local
            // sources only hash their build inputs. A bad URI, wrong region,
            // inaccessible image, or invalid build source therefore cannot
            // strand an IAM role when pre-create fails before persisting state.
            yield* functionImage.identity(id, news.image, news.architecture);
          }
          const { accountId, region } = yield* AWSEnvironment.current;
          const { roleName, functionName, roleArn } = yield* createNames(
            id,
            news.functionName,
          );

          const role = yield* createRoleIfNotExists({
            id,
            roleName,
            vpc: news.vpc,
          });

          const prepared = yield* preparePrecreatedFunctionCode({
            id,
            props: news,
            session,
          });

          yield* createOrUpdateFunction({
            id,
            news,
            roleArn: role.Role.Arn,
            code: prepared.deployment,
            functionName,
            env: alchemyEnv,
            session,
          });

          return {
            functionArn: `arn:aws:lambda:${region}:${accountId}:function:${functionName}`,
            functionName,
            functionUrl: undefined,
            roleName,
            code: prepared.attributes,
            roleArn,
          };
        }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          olds,
          bindings,
          output,
          session,
        }) {
          yield* validateFunctionPackageProps(id, news);
          if (isFunctionImageProps(news)) {
            yield* decodeFunctionImageSource(id, news.image);
          }
          const generated = yield* createNames(id, news.functionName);
          // Prefer the deployed identifiers: regenerating would target
          // different physical resources if the generator's output for this
          // id ever drifts. (An explicit functionName change arrives here as
          // a fresh replacement instance with no output.)
          const functionName = output?.functionName ?? generated.functionName;
          const roleName = output?.roleName ?? generated.roleName;
          const functionArn = output?.functionArn ?? generated.functionArn;
          const policyName = generated.policyName;

          // State is only a cache: the execution role may have been removed
          // out-of-band (or by a previously interrupted cleanup) while the
          // function output remains persisted. Always observe/ensure the
          // deterministic role before syncing binding policies so reconcile
          // can recover from that partial state instead of failing the first
          // `putRolePolicy` with `NoSuchEntityException`.
          const ensuredRole = yield* createRoleIfNotExists({
            id,
            roleName,
            vpc: news.vpc,
          });
          const roleArn = ensuredRole.Role.Arn ?? output?.roleArn;

          const {
            env,
            vpc: bindingVpc,
            fileSystemConfigs: bindingFileSystemConfigs,
          } = yield* attachBindings({
            roleName,
            policyName,
            functionArn,
            functionName,
            bindings,
          });

          // Both VPC paths (the `vpc` prop and binding-channel requests)
          // converge on one Lambda VPC config: set-union of subnets and
          // security groups.
          const vpc =
            news.vpc || bindingVpc
              ? {
                  subnetIds: [
                    ...new Set([
                      ...(news.vpc?.subnetIds ?? []),
                      ...(bindingVpc?.subnetIds ?? []),
                    ]),
                  ],
                  securityGroupIds: [
                    ...new Set([
                      ...(news.vpc?.securityGroupIds ?? []),
                      ...(bindingVpc?.securityGroupIds ?? []),
                    ]),
                  ],
                }
              : undefined;

          // The role may predate the VPC request (precreate stub, or a
          // binding newly asking for attachment) — the ENI permissions must
          // be on the role before the function config references the VPC.
          // Attaching is idempotent.
          if (vpc) {
            yield* iam.attachRolePolicy({
              RoleName: roleName,
              PolicyArn:
                "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
            });
          }

          yield* syncTracingPolicy({
            roleName,
            tracing: news.tracing,
            // Routine update from Active, or adoption (output without olds)
            // where the prior tracing mode is unknown.
            mayHaveBeenActive:
              olds?.tracing === "Active" ||
              (olds === undefined && output !== undefined),
          });

          // Desired EFS mounts: the `fileSystemConfigs` prop (access-point
          // references resolved to ARNs) merged with binding-channel
          // requests (`EFS.Mount`), deduped by mount path.
          const desiredFileSystemConfigs = [
            ...new Map(
              [
                ...(news.fileSystemConfigs ?? []).map((c) => {
                  const arn = accessPointArnOf(c);
                  if (arn === undefined) {
                    throw new Error(
                      `Function(${id}): fileSystemConfigs entry for ${c.localMountPath} needs an access point — set \`accessPoint\` (an AWS.EFS.AccessPoint resource or its ARN) or \`arn\``,
                    );
                  }
                  return { Arn: arn, LocalMountPath: c.localMountPath };
                }),
                ...bindingFileSystemConfigs.map((c) => ({
                  Arn: c.arn,
                  LocalMountPath: c.localMountPath,
                })),
              ].map((config) => [config.LocalMountPath, config] as const),
            ).values(),
          ];

          // EFS mounts authenticate the execution role against the access
          // point at sandbox start — grant client access before the function
          // configuration references the file system. Attaching is
          // idempotent; the policy is detached with the rest on delete.
          if (desiredFileSystemConfigs.length > 0) {
            yield* iam.attachRolePolicy({
              RoleName: roleName,
              PolicyArn:
                "arn:aws:iam::aws:policy/AmazonElasticFileSystemClientReadWriteAccess",
            });
          }

          const prepared = yield* prepareFunctionCode({
            id,
            props: news,
            previousImage: output?.code?.image,
            session,
          });

          yield* createOrUpdateFunction({
            id,
            news,
            roleArn,
            code: prepared.deployment,
            env: {
              ...env,
              ...news.env,
            },
            functionName,
            vpc,
            preferUpdate: output !== undefined,
            // `[]` (when the prop/bindings were removed on a function that
            // previously had mounts) explicitly clears the file-system
            // config; `undefined` when it never had any leaves it untouched.
            fileSystemConfigs:
              desiredFileSystemConfigs.length > 0
                ? desiredFileSystemConfigs
                : olds?.fileSystemConfigs || output !== undefined
                  ? []
                  : undefined,
            session,
          });

          const previousImage = output?.code.image;
          const nextImage =
            "image" in prepared.attributes
              ? prepared.attributes.image
              : undefined;
          if (
            previousImage?.ownsRepository === true &&
            previousImage.repositoryUri !== nextImage?.repositoryUri
          ) {
            // The function has moved from an Alchemy-owned local image to a
            // different source. Wait until Lambda has adopted the new digest
            // before deleting the now-unreferenced managed repository.
            yield* waitForFunctionUpdate(functionName, session);
            yield* functionImage.deleteRepository(previousImage.repositoryName);
          }

          const reservedConcurrentExecutions =
            yield* syncReservedConcurrentExecutions({
              functionName,
              reservedConcurrentExecutions: news.reservedConcurrentExecutions,
            });

          yield* syncEventInvokeConfig({
            functionName,
            config: news.eventInvokeConfig,
          });

          const functionUrl = yield* createOrUpdateFunctionUrl({
            functionName,
            url: news.functionUrl,
            oldUrl: olds?.functionUrl,
            currentFunctionUrl: output?.functionUrl,
          });

          yield* session.note(summary(prepared.deployment));

          return {
            ...output,
            functionArn,
            functionName,
            functionUrl: functionUrl as any,
            roleName,
            roleArn,
            code: prepared.attributes,
            reservedConcurrentExecutions,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // The role may already be gone (e.g. deleted out-of-band or by a
          // previous partial delete) — treat every step as idempotent.
          yield* iam
            .listRolePolicies({
              RoleName: output.roleName,
            })
            .pipe(
              Effect.flatMap((policies) =>
                Effect.all(
                  (policies.PolicyNames ?? []).map((policyName) =>
                    iam
                      .deleteRolePolicy({
                        RoleName: output.roleName,
                        PolicyName: policyName,
                      })
                      .pipe(
                        Effect.catchTag(
                          "NoSuchEntityException",
                          () => Effect.void,
                        ),
                      ),
                  ),
                ),
              ),
              Effect.catchTag("NoSuchEntityException", () => Effect.void),
            );

          yield* iam
            .listAttachedRolePolicies({
              RoleName: output.roleName,
            })
            .pipe(
              Effect.flatMap((policies) =>
                Effect.all(
                  (policies.AttachedPolicies ?? []).map((policy) =>
                    iam
                      .detachRolePolicy({
                        RoleName: output.roleName,
                        PolicyArn: policy.PolicyArn!,
                      })
                      .pipe(
                        Effect.catchTag(
                          "NoSuchEntityException",
                          () => Effect.void,
                        ),
                      ),
                  ),
                ),
              ),
              Effect.catchTag("NoSuchEntityException", () => Effect.void),
            );

          yield* Lambda.deleteFunction({
            FunctionName: output.functionName,
          }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );

          if (output.code.image?.ownsRepository) {
            // Lambda must release its image before the owned repository is
            // force-deleted. Both operations are idempotent, so an interrupted
            // destroy converges on the next run.
            yield* functionImage.deleteRepository(
              output.code.image.repositoryName,
            );
          }

          // Release the execution role before the auxiliary CloudWatch Logs
          // reap below. A recently invoked function can keep that reap alive
          // for ~40 seconds while Lambda flushes its final log batches; if the
          // process is interrupted during that window, leaving role deletion
          // until afterwards strands the deterministic role. IAM can briefly
          // report the just-detached role as still in use, so retry those
          // eventual-consistency conflicts on a bounded schedule.
          yield* iam.deleteRole({ RoleName: output.roleName }).pipe(
            Effect.catchTag("NoSuchEntityException", () => Effect.void),
            Effect.retry({
              while: (error) =>
                error._tag === "DeleteConflictException" ||
                error._tag === "ConcurrentModificationException",
              schedule: Schedule.spaced("2 seconds"),
              times: 10,
            }),
          );

          // CloudWatch Logs is not implemented by the floci emulator. The
          // live reap below (flush watch + observe→delete) would sit on
          // describe/delete timeouts for minutes; emulator log groups die
          // with the container anyway.
          if (yield* AWSEnvironment.isLocalEmulator) {
            return null as any;
          }

          // Lambda auto-creates /aws/lambda/{name} on the first invoke and
          // deleteFunction does NOT remove it — without this every deleted
          // function leaks an orphaned log group. Worse, the Lambda service
          // flushes the final log batch asynchronously (observed up to ~35s
          // after the last invoke, even after BOTH the function and its role
          // are already deleted), silently re-creating a just-deleted group.
          // The only reliable reap is a bounded watch over that flush window.
          // A provably-quiescent group (last ingestion > 2 minutes ago —
          // every pending flush has long since landed) deletes in a single
          // call, so routine deletes of idle functions stay fast; a group
          // with recent ingestion — or one that does not exist yet, where a
          // first flush may still be in flight — is re-reaped on a short
          // bounded schedule.
          const logGroupName = `/aws/lambda/${output.functionName}`;
          const reapLogGroup = logs.deleteLogGroup({ logGroupName }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            // CloudWatch Logs can sit in its SDK retry path for minutes
            // under a full parallel sweep. Log-group cleanup is auxiliary
            // to the already-completed Lambda delete, so bound each reap
            // attempt while preserving the t=0/20/40 flush watch below.
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () =>
                Effect.logWarning(
                  `Timed out reaping Lambda log group ${logGroupName}`,
                ),
            }),
          );
          const lastIngestion = yield* logs
            .describeLogStreams({
              logGroupName,
              orderBy: "LastEventTime",
              descending: true,
              limit: 1,
            })
            .pipe(
              Effect.map((r) => r.logStreams?.[0]?.lastIngestionTime),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
              Effect.timeoutOrElse({
                duration: "5 seconds",
                orElse: () =>
                  Effect.gen(function* () {
                    yield* Effect.logWarning(
                      `Timed out inspecting Lambda log group ${logGroupName}`,
                    );
                    return undefined;
                  }),
              }),
            );
          const now = yield* Effect.sync(() => Date.now());
          const quiescent =
            lastIngestion !== undefined && now - lastIngestion > 120_000;
          if (quiescent) {
            yield* reapLogGroup;
          } else {
            // Reaps at t=0s / 20s / 40s — each attempt is idempotent.
            yield* reapLogGroup.pipe(
              Effect.repeat({
                schedule: Schedule.spaced("20 seconds"),
                times: 2,
              }),
            );
          }

          // A timed-out delete attempt above is not deletion proof, and the
          // Lambda service keeps flushing buffered logs AFTER the function is
          // deleted (typically ~35s, occasionally much longer), silently
          // re-creating a just-deleted group. Converge with a bounded
          // observe→delete loop: any reappearance is simply deleted again
          // (every delete is idempotent — ResourceNotFoundException means
          // done). A recreation we deleted counts as gone; a flush landing
          // after our final check is inherently unobservable and the next
          // nuke census is the backstop. We only fail loudly if the group is
          // still observable at budget exhaustion AND a final delete attempt
          // did not remove it — i.e. the group is genuinely undeletable.
          const describeLogGroup = logs
            .describeLogGroups({
              logGroupNamePrefix: logGroupName,
              limit: 1,
            })
            .pipe(
              Effect.map((response) =>
                (response.logGroups ?? []).some(
                  (group) => group.logGroupName === logGroupName,
                ),
              ),
            );

          // Loop observation: a describe that can't complete in time (API
          // throttling under a busy account / saturated test run) is NOT
          // deletion proof — assume the group is still present and let the
          // bounded loop keep converging instead of dying on a slow read.
          const observeLogGroup = describeLogGroup.pipe(
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () =>
                Effect.logWarning(
                  `Timed out observing Lambda log group ${logGroupName} — assuming still present`,
                ).pipe(Effect.as(true)),
            }),
          );

          // Final authoritative observation: here a timeout must fail loudly,
          // since we are about to declare the delete converged.
          const observeLogGroupOrDie = describeLogGroup.pipe(
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () =>
                Effect.die(
                  new Error(
                    `Timed out confirming Lambda log group deletion: ${logGroupName}`,
                  ),
                ),
            }),
          );

          const deleteLogGroupAgain = logs
            .deleteLogGroup({ logGroupName })
            .pipe(
              Effect.retry({
                while: (error) =>
                  error._tag === "OperationAbortedException" ||
                  error._tag === "ServiceUnavailableException",
                schedule: Schedule.max([
                  Schedule.exponential("250 millis"),
                  Schedule.recurs(8),
                ]),
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.timeoutOrElse({
                duration: "45 seconds",
                orElse: () =>
                  Effect.die(
                    new Error(
                      `Timed out deleting Lambda log group ${logGroupName}`,
                    ),
                  ),
              }),
            );

          const reapIfObserved = Effect.gen(function* () {
            const present = yield* observeLogGroup;
            if (present) {
              yield* deleteLogGroupAgain;
            }
            return present;
          });

          // Happy path (no reappearance): a single describe, done. On a
          // post-delete flush recreation: delete and re-check every 5s for
          // up to ~90s after the last reappearance-free observation.
          const observedAtBudgetEnd = yield* reapIfObserved.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (present) => !present,
              times: 18,
            }),
          );

          // Budget exhausted with the group still reappearing: the last loop
          // iteration already issued a delete. One final authoritative
          // observation decides — absent means our delete of the latest
          // recreation stuck (gone); present means the group survives its own
          // deletion (denied/undeletable) and must fail loudly.
          if (observedAtBudgetEnd && (yield* observeLogGroupOrDie)) {
            yield* Effect.die(
              new Error(
                `Lambda log group ${logGroupName} remained observable after delete`,
              ),
            );
          }

          return null as any;
        }),
        tail: ({ output }) => {
          const runTailSession = Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;

            const logGroupArn = `arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${output.functionName}`;
            const response = yield* logs.startLiveTail({
              logGroupIdentifiers: [logGroupArn],
            });

            if (!response.responseStream) {
              return Stream.empty as Stream.Stream<LogLine>;
            }

            return response.responseStream.pipe(
              Stream.flatMap((event) => {
                if ("sessionUpdate" in event && event.sessionUpdate) {
                  const lines: LogLine[] = (
                    event.sessionUpdate.sessionResults ?? []
                  ).flatMap((result) => {
                    if (!result.message) return [];
                    return [
                      {
                        timestamp: new Date(result.timestamp ?? Date.now()),
                        message: result.message.trimEnd(),
                      },
                    ];
                  });
                  return Stream.fromIterable(lines);
                }
                return Stream.empty;
              }),
            );
          });

          return Stream.unwrap(runTailSession).pipe(
            Stream.retry(Schedule.spaced("1 second")),
          );
        },
        logs: ({
          output,
          options,
        }: {
          output: Function["Attributes"];
          options: LogsInput;
        }) =>
          logs
            .filterLogEvents({
              logGroupName: `/aws/lambda/${output.functionName}`,
              startTime: options.since?.getTime(),
              limit: options.limit ?? 100,
            })
            .pipe(
              Effect.map((response) =>
                (response.events ?? []).flatMap((event): LogLine[] => {
                  if (!event.message) return [];
                  return [
                    {
                      timestamp: new Date(event.timestamp ?? Date.now()),
                      message: event.message.trimEnd(),
                    },
                  ];
                }),
              ),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed([] as LogLine[]),
              ),
            ),
      };
    }),
  );
