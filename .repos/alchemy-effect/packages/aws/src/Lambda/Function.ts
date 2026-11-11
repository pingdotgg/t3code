import { createHash } from "node:crypto";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as iam from "@distilled.cloud/aws/iam";
import type { CreateFunctionRequest } from "@distilled.cloud/aws/lambda";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { Region } from "@distilled.cloud/aws/Region";
import { Unowned, Unresolved, UnresolvedIdentity } from "alchemy/AdoptPolicy";
import * as Binding from "alchemy/Binding";
import type * as Bundle from "alchemy/Bundle/Bundle";
import type { PackageInstall } from "alchemy/Bundle/InstalledPackages";
import { deepEqual, havePropsChanged, isResolved, stripEffects } from "alchemy/Diff";
import { isScopeEjected, type HttpEffect } from "alchemy/Http";
import * as Output from "alchemy/Output";
import { createPhysicalName } from "alchemy/PhysicalName";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import type { LogLine, LogsInput } from "alchemy/Provider";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import type { FunctionContext, FunctionListener } from "alchemy/Runtime/Function";
import { packEnvValue, RuntimeContext, unpackEnvValue } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { createInternalTags, createTagsList, hasAlchemyTags, hasTags } from "alchemy/Tags";
import { buildEventTelemetry } from "alchemy/Telemetry";
import { sha256 } from "alchemy/Util/sha256";
import { zipCode } from "alchemy/Util/zip";
import type * as lambda from "aws-lambda";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as rolldown from "rolldown";
import { Assets } from "../Assets.ts";
import { AWSEnvironment } from "../Environment.ts";
import * as IAM from "../IAM/index.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { syncLogGroupRetention, type LogRetentionConfig } from "../Logs/LogRetention.ts";
import type { Providers } from "../Providers.ts";
import {
  observeEventInvokeConfig,
  syncEventInvokeConfig,
  type EventInvokeConfig,
  type ObservedEventInvokeConfig,
} from "./EventInvokeConfig.ts";
import { makeFunctionBundler } from "./FunctionBundle.ts";
import { composeFunctionDomain, functionDomainUrl, type FunctionDomain } from "./FunctionDomain.ts";
import {
  decodeFunctionImageSource,
  type FunctionImageAttributes,
  type FunctionImageIdentity,
  type FunctionImageSource,
  makeFunctionImage,
} from "./FunctionImage.ts";
import {
  isResponseStreaming,
  makeFunctionHttpHandler,
  RESPONSE_STREAM_ENV,
  streamifyHandler,
} from "./HttpServer.ts";
import {
  HandlerContext,
  InvocationDeadlineState,
  lambdaTimeoutOf,
  TIMEOUT_GRACE_ENV,
  toDurationMillis,
  withInvocationDeadline,
} from "./InvocationDeadline.ts";

export class LambdaFunctionInvalidProps extends Data.TaggedError("LambdaFunctionInvalidProps")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type { FunctionImageSource } from "./FunctionImage.ts";
export {
  InvalidFunctionDomain,
  type FunctionDomain,
  type FunctionDomainConfig,
} from "./FunctionDomain.ts";

export const FunctionTypeId = "AWS.Lambda.Function" as const;
export type FunctionTypeId = typeof FunctionTypeId;

class FunctionUpdatePending extends Data.TaggedError("FunctionUpdatePending")<{
  functionName: string;
  state?: string;
  stateReason?: string;
  lastUpdateStatus?: string;
  lastUpdateStatusReason?: string;
}> {
  override get message() {
    return `Lambda function ${this.functionName} is not ready: state=${this.state ?? "unknown"} (${this.stateReason ?? "no reason"}), update=${this.lastUpdateStatus ?? "unknown"} (${this.lastUpdateStatusReason ?? "no reason"})`;
  }
}

class FunctionUpdateFailed extends Data.TaggedError("FunctionUpdateFailed")<{
  functionName: string;
  reason?: string;
  /** `LastUpdateStatusReasonCode` (or `StateReasonCode` for a failed create). */
  reasonCode?: string;
}> {
  override get message() {
    return `Lambda function ${this.functionName} update failed: ${this.reason ?? "unknown reason"}`;
  }
}

export const isFunction = (value: any): value is Function =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  value.Type === "AWS.Lambda.Function";

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
  /**
   * Rolldown output options. The bundle is minified with `keepNames` by
   * default; source maps ship with it and Node maps stack traces back to your
   * source. Set `minify: false` to ship readable code.
   */
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
/** Inline policy denying the execution role `logs:CreateLogGroup` on its own group. */
const logGroupGuardPolicyName = "AlchemyDenyLogGroupCreate";

const accessPointArnOf = (config: {
  accessPoint?: AccessPointRef;
  arn?: string;
}): string | undefined =>
  typeof config.accessPoint === "string"
    ? config.accessPoint
    : typeof (config.accessPoint as { accessPointArn?: unknown } | undefined)?.accessPointArn ===
        "string"
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
   * Invocation mode for the function URL. `RESPONSE_STREAM` streams an
   * Effect handler's `HttpServerResponse` body to the client as it is
   * produced; `BUFFERED` returns it once complete (up to 6 MB).
   * @default "BUFFERED"
   */
  invokeMode?: Lambda.InvokeMode;
}

export interface FunctionCommonProps extends PlatformProps {
  /**
   * Whether to create a Lambda function URL, or its configuration.
   *
   * Omitting it creates a **public, unauthenticated** Function URL: the same
   * as `functionUrl: true`, which sets `authType: "NONE"` and grants
   * `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` (via the URL) to
   * `Principal: "*"`.
   * Set `functionUrl: false` for Functions that only consume events, or
   * `{ authType: "AWS_IAM" }` to require SigV4-signed requests.
   * @default true
   */
  functionUrl?: boolean | FunctionUrlConfig;
  /**
   * Route every invocation through a Lambda alias of this name.
   *
   * Each deploy publishes a version (Lambda reuses the latest one when the
   * code and configuration are unchanged) and points the alias at it. The
   * function URL, event-source mappings, invoke permissions, API Gateway
   * integrations, the custom `domain`, and the function-level
   * `eventInvokeConfig`, and the durable executions a `DurableFunction` or
   * `WorkflowFunction` starts all target the alias instead of `$LATEST`, so rolling
   * back is a single `UpdateAlias` call to a previous version. Published
   * versions are retained.
   *
   * Adding or removing `alias` moves the function URL to a new address
   * (qualified and unqualified URLs differ).
   */
  alias?: string;
  /**
   * Serve the Function on a custom domain. Function URLs cannot take custom
   * hostnames, so this composes an API Gateway v2 HTTP API in front of the
   * Function (`$default` route, payload 2.0 — the Function URL event shape,
   * so an Effect `fetch` handler works unchanged), a regional ACM
   * certificate, an API Gateway domain name + API mapping per hostname, and
   * the DNS records. The Function's `domainUrl` attribute is
   * `https://{name}`.
   *
   * A string is a hostname in a Route 53 hosted zone. Use the object form
   * for aliases, a pinned hosted zone, or another DNS host via `dns` (e.g.
   * `Cloudflare.DNS.Adapter()`).
   *
   * Not composed while the Function runs locally under `alchemy dev`
   * (pipe it through `Alchemy.remote()` to serve the domain in dev).
   */
  domain?: FunctionDomain;
  functionName?: string;
  /**
   * Instruction set architecture for the Lambda function.
   */
  architecture?: FunctionArchitecture;
  /**
   * Memory allocated to the function, in MB.
   *
   * @default 128
   */
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
   * Maximum execution time of an invocation.
   *
   * At the timeout the runtime interrupts the handler, like `runMain` does on
   * SIGTERM: `acquireRelease`, `ensuring` and scope finalizers run, every
   * open span ends with an `AWS.Lambda.InvocationTimeoutError`. Lambda
   * itself is configured with `timeout + timeoutMargin`, rounded up to whole
   * seconds, so the cleanup and the telemetry flush run in that margin
   * instead of being cut off. The invocation is then held until Lambda's own
   * timeout ends it, so Lambda still logs, counts and retries a timeout and
   * resets the sandbox, and work that ignored the interruption cannot leak
   * into the next invocation.
   *
   * Functions alchemy's runtime does not run (`image`, `isExternal`,
   * `bundle: false`) and durable functions are never interrupted: Lambda is
   * configured with the timeout as-is, rounded up to whole seconds.
   *
   * @default 3 seconds (AWS Lambda default)
   */
  timeout?: Duration.Duration;
  /**
   * Extra time Lambda gives an invocation after {@link timeout} interrupts
   * it, for finalizers and the telemetry flush. Lambda's timeout is
   * configured as `timeout + timeoutMargin`, rounded up to whole seconds;
   * the margin is billed only when an invocation actually runs past its
   * timeout. `timeout + timeoutMargin` must fit in Lambda's 900-second
   * maximum, and a queue an SQS event source reads needs a
   * `visibilityTimeout` of at least that sum (SQS's default is 30 seconds).
   *
   * If cleanup is still running 500 ms before Lambda's own timeout, the
   * runtime ends the invocation's root span, logs a warning and drains the
   * exporters, so the trace is exported even if Lambda kills the process.
   *
   * Set to `Duration.zero` to never interrupt the handler: Lambda kills the
   * invocation at {@link timeout} and the runtime only flushes telemetry
   * 500 ms before that.
   *
   * @default 1 second
   */
  timeoutMargin?: Duration.Duration;
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
  /**
   * Retention for the function's CloudWatch log group
   * (`/aws/lambda/<functionName>`), e.g. `{ retention: "2 weeks" }` or
   * `{ retention: "forever" }`. When set, Alchemy creates (or adopts) the
   * log group so the policy applies before the first invocation, and
   * deletes it with the function. When omitted the log group is left to
   * Lambda, which creates it on first invoke with no expiry.
   */
  logging?: LogRetentionConfig;
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
   * derived from `main`'s basename (e.g. `index.mjs` → `index.default`).
   * @default true
   */
  bundle?: false;
  image?: never;
  /**
   * Name of the export in `main` that Lambda invokes. Only applies to async
   * handlers (`main` exports a plain Lambda handler); Effect Functions are
   * wrapped in a generated entry and ignore it.
   * @default "default"
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
   * Bundler configuration for {@link main}: rolldown input options, `output`
   * overrides, `install` for native packages, `pure`, and the bundle analyzer.
   * Unused code is tree-shaken. `effect`, alchemy, and `@distilled.cloud`
   * are marked pure so unused parts prune more aggressively. List extra
   * packages with `pure.packages`, or disable with `pure: false`.
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

const isFunctionImageProps = (props: FunctionProps): props is FunctionImageProps =>
  props.image !== undefined;

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
export const validateFunctionPackageProps = Effect.fn("AWS.Lambda.validateFunctionPackageProps")(
  function* (id: string, props: FunctionPackageValidationProps) {
    if (props.image === undefined) {
      if (props.main === undefined) {
        return yield* new LambdaFunctionInvalidProps({
          message: `Function(${id}): declare exactly one of main or image`,
        });
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
      return yield* new LambdaFunctionInvalidProps({
        message: `Function(${id}): image functions cannot use ZIP/runtime options: ${incompatible.join(", ")}`,
      });
    }
  },
);

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
        EntryPoint: config.entryPoint === undefined ? undefined : [...config.entryPoint],
        WorkingDirectory: config.workingDirectory,
      };

/**
 * `UpdateFunctionConfiguration` preserves old image overrides when the field
 * is omitted. An empty object therefore means "clear overrides" on update.
 */
const imageConfigForUpdate = (props: FunctionProps): Lambda.ImageConfig | undefined =>
  isFunctionImageProps(props) ? (toLambdaImageConfig(props.image) ?? {}) : undefined;

/**
 * Whether alchemy's runtime interrupts the function's invocations at its
 * `timeout` (see `withInvocationDeadline`). Images, external handlers and
 * prebuilt bundles run the user's own entrypoint; durable invocations are
 * replayed from checkpoints and never interrupted.
 */
const interruptsAtTimeout = (props: FunctionProps): boolean =>
  !isFunctionImageProps(props) &&
  !props.isExternal &&
  props.bundle !== false &&
  props.durableConfig === undefined;

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
          .slice(Math.max(props.main.lastIndexOf("/"), props.main.lastIndexOf("\\")) + 1)
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
export const toTimeoutSeconds = (timeout: Duration.Duration | undefined): number | undefined => {
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
    /**
     * ARN that invokes the Function: the alias ARN
     * (`arn:…:function:name:alias`) when `alias` is set, otherwise the
     * unqualified {@link functionArn}. Use {@link qualifiedArnOf} to wire it.
     */
    qualifiedArn: string;
    /**
     * Name of the alias every consumer invokes, when `alias` is set.
     */
    aliasName?: string;
    /**
     * Version the alias points at, when `alias` is set.
     */
    version?: string;
    functionUrl: string | undefined;
    /**
     * `https://{domain.name}` when the Function has a custom `domain`.
     */
    domainUrl?: string;
    roleName: string;
    roleArn: string;
    code: {
      hash: string;
      image?: Omit<FunctionImageAttributes, "hash">;
    };
    reservedConcurrentExecutions?: number;
    /**
     * Memory allocated to the function, in MB, as observed on the deployed
     * function. Lets `alchemy drift` detect out-of-band changes.
     */
    memorySize?: number;
    /**
     * Timeout of the function, in seconds, as observed on the deployed
     * function. Lets `alchemy drift` detect out-of-band changes.
     */
    timeoutSeconds?: number;
    /**
     * Runtime of the function (ZIP packages only), as observed on the
     * deployed function. Lets `alchemy drift` detect out-of-band changes.
     */
    runtime?: string;
    /**
     * Handler string of the function (ZIP packages only), as observed on the
     * deployed function. Lets `alchemy drift` detect out-of-band changes.
     */
    handler?: string;
    /**
     * Instruction set architecture, as observed on the deployed function.
     * Lets `alchemy drift` detect out-of-band changes.
     */
    architecture?: string;
    /**
     * ARNs of the attached layer versions, in order, as observed on the
     * deployed function. Lets `alchemy drift` detect out-of-band changes.
     */
    layers?: string[];
    /**
     * Environment variables of the deployed function, each value replaced by
     * a SHA-256 fingerprint so secrets never reach state. Lets
     * `alchemy drift` detect out-of-band additions, removals and edits.
     */
    environment?: Record<string, string>;
    /**
     * VPC attachment, as observed on the deployed function. Lets
     * `alchemy drift` detect out-of-band changes.
     */
    vpcConfig?: {
      subnetIds: string[];
      securityGroupIds: string[];
    };
    /**
     * EFS mounts, as observed on the deployed function. Lets `alchemy drift`
     * detect out-of-band changes.
     */
    fileSystemConfigs?: {
      arn: string;
      localMountPath: string;
    }[];
    /**
     * X-Ray tracing mode, as observed on the deployed function. Lets
     * `alchemy drift` detect out-of-band changes.
     */
    tracing?: string;
    /**
     * SHA-256 of the deployed code package, as reported by Lambda. Lets
     * `alchemy drift` detect code replaced out-of-band.
     */
    codeSha256?: string;
    /**
     * Function URL settings, as observed on the deployed URL. Lets
     * `alchemy drift` detect out-of-band authentication or CORS changes.
     */
    functionUrlConfig?: {
      authType?: string;
      invokeMode?: string;
      cors?: Lambda.Cors;
    };
    /**
     * Retention of the function's log group in days (`undefined` when logs
     * never expire), observed when `logging.retention` is set. Lets
     * `alchemy drift` detect out-of-band changes.
     */
    logRetentionInDays?: number;
    /**
     * Policies Alchemy manages on the execution role, as observed: the AWS
     * managed policies Alchemy attaches, and the inline policy documents it
     * writes (binding statements and the log-group guard). Lets
     * `alchemy drift` detect out-of-band detaches and edits.
     */
    executionRole?: {
      managedPolicyArns: string[];
      inlinePolicies: Record<string, unknown>;
    };
    /**
     * Asynchronous invocation config (retries, maximum event age,
     * destinations) of the function, or of its alias when `alias` is set,
     * as observed. Lets `alchemy drift` detect out-of-band changes.
     */
    eventInvokeConfig?: ObservedEventInvokeConfig;
    /**
     * Durable execution settings (execution timeout and history retention),
     * as observed on durable functions. Lets `alchemy drift` detect
     * out-of-band changes.
     */
    durableConfig?: {
      executionTimeout?: number;
      retentionPeriodInDays?: number;
    };
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

/**
 * Lambda refused to publish a version or create the alias for a Function
 * with `alias`. Published versions are retained, so they count toward the
 * account's code-storage quota until you delete the ones no alias serves.
 */
export class FunctionAliasPublishFailed extends Data.TaggedError("FunctionAliasPublishFailed")<{
  functionName: string;
  alias: string;
  reason: "CodeStorageExceeded" | "VersionLimitExceeded" | "AliasLimitExceeded";
  message: string;
}> {}

/** An event source was used inside a Lambda Web Function. */
export class EventSourceRequiresFunction extends Data.TaggedError("EventSourceRequiresFunction")<{
  eventSource: string;
  message: string;
}> {}

/**
 * The `AWS.Lambda.Function` an event source attaches to. A Lambda Web
 * Function only receives HTTP and can't be an event source target, so name
 * the problem there instead of failing with a missing-service error (the
 * typed API already rejects it; this covers untyped JavaScript).
 */
export const eventSourceHost = (eventSource: string) =>
  Effect.flatMap(Binding.Host, (host) =>
    host?.Type === "AWS.Lambda.WebFunction"
      ? Effect.die(
          new EventSourceRequiresFunction({
            eventSource,
            message: `${eventSource} needs an AWS.Lambda.Function, but "${host.LogicalId}" is an AWS.Lambda.WebFunction, which only receives HTTP. Consume the event source from an AWS.Lambda.Function instead.`,
          }),
        )
      : Function,
  );

export { qualifiedArnOf, qualifiedNameOf } from "./QualifiedArn.ts";

export type FunctionServices =
  | Credentials
  | Region
  | AWSEnvironment
  // The host itself, provided to the implementation at runtime (like Cloudflare's Worker).
  | Function;

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
 * See [Effect handlers vs async handlers](/infrastructure-as-effects/runtime#effect-handlers-vs-async-handlers)
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
 * import * as AWS from "@alchemy.run/aws";
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
 * export default async (event: any) => {
 *   return {
 *     statusCode: 200,
 *     body: JSON.stringify({ message: "Hello from Lambda!" }),
 *   };
 * };
 * ```
 *
 * **Example:** Invoking a named export
 * ```typescript
 * // src/handler.ts exports `handler` instead of a default export
 * const func = yield* AWS.Lambda.Function("ApiFunction", {
 *   main: "./src/handler.ts",
 *   handler: "handler",
 * });
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
 * ### Function URL access
 * Every Function gets a public, unauthenticated Function URL unless you
 * opt out. `functionUrl` has three access choices: `false` (no URL),
 * `true` (public, the default), and `{ authType: "AWS_IAM" }` (signed
 * requests only).
 *
 * **Example:** Public Function URL
 * ```typescript
 * const func = yield* AWS.Lambda.Function("ApiFunction", {
 *   main: "./src/handler.ts",
 *   functionUrl: true,
 * });
 * ```
 *
 * **Example:** Event consumer without a Function URL
 * ```typescript
 * const func = yield* AWS.Lambda.Function("JobsWorker", {
 *   main: "./src/worker.ts",
 *   functionUrl: false,
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
 * ### Streaming responses
 * Set the Function URL's `invokeMode` to `"RESPONSE_STREAM"` and a streamed
 * `HttpServerResponse` reaches the client chunk by chunk instead of being
 * buffered. Use it for server-sent events, LLM tokens, progressive HTML, and
 * responses over the 6 MB buffered limit (streams go up to 20 MB).
 *
 * **Example:** Server-sent events
 * ```typescript
 * // src/events.ts
 * import * as AWS from "@alchemy.run/aws";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Stream from "effect/Stream";
 *
 * export default class Events extends AWS.Lambda.Function<Events>()(
 *   "Events",
 *   { main: import.meta.url, functionUrl: { invokeMode: "RESPONSE_STREAM" } },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(
 *         HttpServerResponse.stream(
 *           Stream.make("data: one\n\n", "data: two\n\n").pipe(
 *             Stream.tap(() => Effect.sleep("1 second")),
 *             Stream.encodeText,
 *           ),
 *           { contentType: "text/event-stream" },
 *         ),
 *       ),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Configuration
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
 * ### Custom Domains
 * Function URLs cannot serve a custom hostname, so `domain` puts an API
 * Gateway v2 HTTP API in front of the Function (payload 2.0 — the same
 * event shape as a Function URL, so a `fetch` handler works unchanged),
 * with a regional ACM certificate, an API Gateway domain name per
 * hostname, and the DNS records. `domainUrl` is `https://{domain.name}`.
 *
 * **Example:** Domain in Route 53 (default)
 * ```typescript
 * const func = yield* AWS.Lambda.Function("Api", {
 *   main: "./src/handler.ts",
 *   domain: "api.example.com",
 * });
 * // func.domainUrl -> "https://api.example.com"
 * ```
 *
 * **Example:** Aliases and a pinned hosted zone
 * ```typescript
 * const func = yield* AWS.Lambda.Function("Api", {
 *   main: "./src/handler.ts",
 *   domain: {
 *     name: "api.example.com",
 *     aliases: ["www.api.example.com"],
 *     hostedZoneId: "Z1234567890",
 *   },
 * });
 * ```
 *
 * **Example:** Domain whose DNS lives in Cloudflare
 * The certificate is validated and each hostname CNAMEd through Cloudflare;
 * the stack's providers must include `Cloudflare.providers()`.
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 *
 * const func = yield* AWS.Lambda.Function("Api", {
 *   main: "./src/handler.ts",
 *   domain: {
 *     name: "api.example.com",
 *     dns: Cloudflare.DNS.Adapter({ zone: "example.com" }),
 *   },
 * });
 * ```
 *
 * ### Bundling & Tree-shaking
 * `main` is bundled with rolldown at deploy time. Unused code is
 * tree-shaken. `effect`, alchemy, and `@distilled.cloud` are marked
 * pure so unused parts prune more aggressively. Your app is not
 * marked pure.
 *
 * **Example:** Mark additional packages as pure
 * Only list packages with no top-level side effects.
 * ```typescript
 * const func = yield* AWS.Lambda.Function("ApiFunction", {
 *   main: "./src/handler.ts",
 *   build: {
 *     pure: { packages: ["my-lib", "@my-scope/*"] },
 *   },
 * });
 * ```
 *
 * **Example:** Turn it off
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
 * ### GCP Bindings
 * A GCP binding reaches Google Cloud through workload identity federation:
 * the function's role may impersonate a service account that holds the
 * binding's roles, so no service account key is created. A new grant can
 * take a few minutes to start working.
 *
 * **Example:** Publish to a Pub/Sub topic
 * ```typescript
 * // init
 * const publish = yield* GCP.PubSub.Publish(topic);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* publish({ body: { messages: [{ data: btoa("hello") }] } });
 *     return HttpServerResponse.text("Published");
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
 * yield* SQS.consumeQueueMessages(
 *   queue,
 *   Effect.fn(function* (event) {
 *     for (const message of event.Records) {
 *       yield* Effect.log(`Received: ${message.body}`);
 *     }
 *   }),
 * );
 * ```
 *
 * **Example:** Process DynamoDB stream changes
 * ```typescript
 * yield* AWS.DynamoDB.consumeTableChanges(
 *   table,
 *   { streamViewType: "NEW_AND_OLD_IMAGES" },
 *   Effect.fn(function* (event) {
 *     for (const record of event.Records) {
 *       yield* Effect.log(`Change: ${record.eventName}`);
 *     }
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
  FunctionContext,
  {},
  FunctionZipProps
> = Platform(FunctionTypeId, {
  // The custom-domain front door integrates the Function's own ARN, so it
  // composes AFTER the Function resource is declared.
  onCreate: (resource, props) =>
    composeFunctionDomain(resource as Function, (props as FunctionProps | undefined)?.domain),
  createRuntimeContext: (id: string): FunctionContext => {
    const listeners: Effect.Effect<FunctionListener>[] = [];
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
        // must never resolve through `Config.String`.
        Effect.sync(() => unpackEnvValue<T>(process.env[key])),
      serve: (handler: HttpEffect) =>
        ctx.listen(
          // @ts-ignore
          Effect.map(isResponseStreaming, (responseStream) =>
            makeFunctionHttpHandler(handler, { responseStream }),
          ),
        ),
      listen: ((handler: FunctionListener | Effect.Effect<FunctionListener>) =>
        Effect.sync(() =>
          Effect.isEffect(handler)
            ? listeners.push(handler)
            : listeners.push(Effect.succeed(handler)),
        )) as any as FunctionContext["listen"],
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
          const services = Context.omit(Layer.CurrentMemoMap)(yield* Effect.context<never>());
          const dispatch = async (event: any, context: lambda.Context): Promise<any> => {
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
                //
                // `withInvocationDeadline` interrupts the handler at the
                // Function's `timeout`, so its finalizers run and its spans
                // end inside Lambda's `timeoutMargin`, before this scope
                // flushes the telemetry.
                const scope = Scope.makeUnsafe();
                const deadline = { fired: false };
                const exit = await eff.pipe(
                  withInvocationDeadline(),
                  Effect.provide(
                    Layer.mergeAll(
                      Layer.succeed(HandlerContext, context),
                      Layer.succeed(InvocationDeadlineState, deadline),
                      Layer.succeed(Scope.Scope, scope),
                      // Runtime readers (e.g. bindings that read their
                      // values through `RuntimeContext.get`) run in the
                      // handler, like on every other host bridge.
                      Layer.succeed(RuntimeContext, ctx as FunctionContext),
                      // The configured telemetry exporters, attached to the
                      // invocation scope by `buildEventTelemetry` so
                      // buffered spans/logs/metrics flush when it settles
                      // below.
                      Layer.effectContext(
                        buildEventTelemetry(services, scope, (ctx as FunctionContext).telemetry),
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
                if (deadline.fired) {
                  // The handler ran past its `timeout`: it was interrupted,
                  // its finalizers ran and its telemetry flushed. Hold the
                  // invocation until Lambda's own timeout ends it, so Lambda
                  // reports and retries a real timeout and resets the
                  // sandbox — work that ignored the interruption can never
                  // resume in the next invocation.
                  await new Promise<never>(() => {});
                }
                if (Exit.isSuccess(exit)) {
                  return exit.value;
                }
                throw Cause.squash(exit.cause);
              }
            }
            throw new Error("No event handler found");
          };
          // `invokeMode: "RESPONSE_STREAM"` needs a streaming handler.
          return (yield* isResponseStreaming) ? streamifyHandler(dispatch) : dispatch;
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

      const createFunctionName = (id: string, functionName: string | undefined) =>
        Effect.gen(function* () {
          return functionName ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        });

      const createRoleName = (id: string) => createPhysicalName({ id, maxLength: 64 });

      const createPolicyName = (id: string) => createPhysicalName({ id, maxLength: 128 });

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
          (binding: ResourceBinding<Function["Binding"]> & { action?: string }) =>
            binding.action !== "delete",
        );
        const env = activeBindings
          .map((binding) => binding?.data?.env)
          .reduce((acc, env) => ({ ...acc, ...env }), {});
        const policyStatements = activeBindings.flatMap(
          (binding) =>
            binding?.data?.policyStatements?.map((stmt: IAM.PolicyStatement) => ({
              ...stmt,
              Sid: stmt.Sid?.replace(/[^A-Za-z0-9]+/gi, ""),
            })) ?? [],
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
                subnetIds: [...new Set(vpcRequests.flatMap((v) => v.subnetIds))],
                securityGroupIds: [...new Set(vpcRequests.flatMap((v) => v.securityGroupIds))],
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

      const xrayWriteAccessPolicyArn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess";

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
          .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.undefined));
        if (role === undefined) {
          // Engine has cleared us via `read` or `observe` — foreign-tagged
          // functions are surfaced as `Unowned` and require `--adopt`. On a race between
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
            PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          })
          .pipe(Effect.tapError(Effect.logDebug), Effect.tap(Effect.logDebug));

        if (vpc) {
          yield* iam
            .attachRolePolicy({
              RoleName: roleName,
              PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
            })
            .pipe(Effect.tapError(Effect.logDebug), Effect.tap(Effect.logDebug));
        }

        yield* Effect.logDebug(`attached policy ${id}`);
        return role;
      });

      /**
       * Deny the execution role `logs:CreateLogGroup` on the function's own
       * `/aws/lambda/<name>` group. The managed `AWSLambdaBasicExecutionRole`
       * allows it on `*`, which lets Lambda create the group with no tags or
       * retention on first invoke, and lets a log batch flushed after
       * `deleteFunction` silently re-create a group we just deleted. With the
       * Deny, Alchemy owns the group (see {@link ensureLogGroup}): Lambda only
       * writes into it, and `delete` removes it once.
       */
      const syncLogGroupGuard = Effect.fn(function* ({
        roleName,
        functionName,
      }: {
        roleName: string;
        functionName: string;
      }) {
        const { accountId, region } = yield* AWSEnvironment.current;
        const document = JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Deny",
              Action: "logs:CreateLogGroup",
              Resource: `arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${functionName}:*`,
            },
          ],
        });
        const observed = yield* iam
          .getRolePolicy({ RoleName: roleName, PolicyName: logGroupGuardPolicyName })
          .pipe(
            Effect.map((policy) => decodeURIComponent(policy.PolicyDocument)),
            Effect.catchTag("NoSuchEntityException", () => Effect.undefined),
          );
        if (observed !== document) {
          yield* iam.putRolePolicy({
            RoleName: roleName,
            PolicyName: logGroupGuardPolicyName,
            PolicyDocument: document,
          });
        }
      });

      /**
       * Create (or adopt) `/aws/lambda/<name>` before the function can run.
       * The execution role cannot create it (see {@link syncLogGroupGuard}),
       * so without this the function's logs would be dropped.
       */
      const ensureLogGroup = Effect.fn(function* ({
        id,
        functionName,
        retention,
      }: {
        id: string;
        functionName: string;
        retention: LogRetentionConfig["retention"] | undefined;
      }) {
        const logGroupName = `/aws/lambda/${functionName}`;
        yield* logs
          .createLogGroup({ logGroupName, tags: yield* createInternalTags(id) })
          .pipe(Effect.catchTag("ResourceAlreadyExistsException", () => Effect.void));
        yield* syncLogGroupRetention({ logGroupName, retention });
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
          NODE_OPTIONS: current ? `${current} --enable-source-maps` : "--enable-source-maps",
        };
      };

      // The runtime reads the grace between the Function's `timeout` and
      // Lambda's per invocation (see `withInvocationDeadline`); only
      // written when the handler is interrupted at all.
      const timeoutGraceEnv = (graceMs: number): Record<string, string> =>
        graceMs > 0 ? { [TIMEOUT_GRACE_ENV]: String(graceMs) } : {};

      // A `RESPONSE_STREAM` Function URL tells the runtime to export its
      // handler through `awslambda.streamifyResponse`.
      const responseStreamEnv = (url: FunctionProps["functionUrl"]): Record<string, string> =>
        normalizeFunctionUrl(url)?.invokeMode === "RESPONSE_STREAM"
          ? { [RESPONSE_STREAM_ENV]: "true" }
          : {};

      const retryFunctionMutation = Effect.retry({
        while: (e: any) =>
          e._tag === "ResourceConflictException" || e._tag === "TooManyRequestsException",
        schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(30)]),
      }) as <A, R, Err>(self: Effect.Effect<A, Err, R>) => Effect.Effect<A, Err, R>;

      const waitForFunctionUpdate = Effect.fn(function* (
        functionName: string,
        session: { note: (note: string) => Effect.Effect<void> },
        vpc: boolean,
      ) {
        return yield* Effect.gen(function* () {
          const configuration = (yield* Lambda.getFunction({
            FunctionName: functionName,
          })).Configuration;
          if (configuration?.State === "Failed" || configuration?.LastUpdateStatus === "Failed") {
            return yield* new FunctionUpdateFailed({
              functionName,
              reason: configuration.LastUpdateStatusReason ?? configuration.StateReason,
              reasonCode:
                configuration.LastUpdateStatus === "Failed"
                  ? configuration.LastUpdateStatusReasonCode
                  : configuration.StateReasonCode,
            });
          }
          if (
            configuration?.State === "Active" &&
            (configuration.LastUpdateStatus === undefined ||
              configuration.LastUpdateStatus === "Successful")
          ) {
            return configuration;
          }
          return yield* new FunctionUpdatePending({
            functionName,
            state: configuration?.State,
            stateReason: configuration?.StateReason,
            lastUpdateStatus: configuration?.LastUpdateStatus,
            lastUpdateStatusReason: configuration?.LastUpdateStatusReason,
          });
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "FunctionUpdatePending",
            schedule: Schedule.spaced("2 seconds").pipe(
              Schedule.tap(({ attempt }) =>
                session.note(
                  `Waiting for Lambda function update: ${functionName} (${attempt * 2}s)`,
                ),
              ),
            ),
            // New VPC attachments can spend several minutes provisioning Hyperplane ENIs.
            times: vpc ? 150 : 30,
          }),
        );
      });

      const getReservedConcurrentExecutions = Effect.fn(function* (functionName: string) {
        return yield* Lambda.getFunctionConcurrency({
          FunctionName: functionName,
        }).pipe(
          Effect.map((config) => config.ReservedConcurrentExecutions),
          Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
        );
      });

      const readFunctionUrlConfig = (functionName: string, qualifier: string | undefined) =>
        Lambda.getFunctionUrlConfig({
          FunctionName: functionName,
          Qualifier: qualifier,
        }).pipe(
          Effect.retry({
            while: (e: any) => e._tag === "ResourceConflictException",
            schedule: Schedule.exponential(100),
          }),
          Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
        );

      // AWS managed policies Alchemy attaches to the execution role. Other
      // attachments (e.g. an `IAM.RolePolicyAttachment` on `roleName`) are
      // not ours to observe.
      const managedExecutionPolicyArns = new Set([
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
        "arn:aws:iam::aws:policy/AmazonElasticFileSystemClientReadWriteAccess",
        xrayWriteAccessPolicyArn,
      ]);

      /**
       * Project the configuration `alchemy drift` compares: every setting
       * reconcile converges, as observed on the deployed function. `read`
       * and `reconcile` share it so a converged function reads unchanged.
       */
      const observeFunctionConfiguration = Effect.fn(function* ({
        id,
        configuration: fn,
        qualifier,
        roleName,
        logging,
      }: {
        id: string;
        configuration: Lambda.FunctionConfiguration;
        qualifier: string | undefined;
        roleName: string;
        logging: FunctionProps["logging"];
      }) {
        const functionName = fn.FunctionName!;
        const policyName = yield* createPolicyName(id);
        const readInlinePolicy = (PolicyName: string) =>
          iam.getRolePolicy({ RoleName: roleName, PolicyName }).pipe(
            Effect.map((policy) => JSON.parse(decodeURIComponent(policy.PolicyDocument))),
            Effect.catchTag("NoSuchEntityException", () => Effect.undefined),
          );
        const [urlConfig, logRetentionInDays, attached, bindingPolicy, guardPolicy, invokeConfig] =
          yield* Effect.all(
            [
              readFunctionUrlConfig(functionName, qualifier),
              logging?.retention === undefined
                ? Effect.undefined
                : logs
                    .describeLogGroups({ logGroupNamePrefix: `/aws/lambda/${functionName}` })
                    .pipe(
                      Effect.map(
                        (result) =>
                          result.logGroups?.find(
                            (group) => group.logGroupName === `/aws/lambda/${functionName}`,
                          )?.retentionInDays,
                      ),
                    ),
              iam.listAttachedRolePolicies({ RoleName: roleName }).pipe(
                Effect.map((result) =>
                  (result.AttachedPolicies ?? []).flatMap((policy) =>
                    policy.PolicyArn && managedExecutionPolicyArns.has(policy.PolicyArn)
                      ? [policy.PolicyArn]
                      : [],
                  ),
                ),
                Effect.catchTag("NoSuchEntityException", () => Effect.succeed([] as string[])),
              ),
              readInlinePolicy(policyName),
              readInlinePolicy(logGroupGuardPolicyName),
              observeEventInvokeConfig(functionName, qualifier),
            ],
            { concurrency: "unbounded" },
          );
        const environment = yield* Effect.sync(() =>
          Object.fromEntries(
            Object.entries(fn.Environment?.Variables ?? {})
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => [
                key,
                createHash("sha256")
                  .update(Redacted.isRedacted(value) ? Redacted.value(value) : (value ?? ""))
                  .digest("hex"),
              ]),
          ),
        );
        const subnetIds = [...(fn.VpcConfig?.SubnetIds ?? [])].sort();
        const fileSystemConfigs = (fn.FileSystemConfigs ?? [])
          .map((config) => ({ arn: config.Arn, localMountPath: config.LocalMountPath }))
          .sort((a, b) => a.localMountPath.localeCompare(b.localMountPath));
        const cors = urlConfig?.Cors;
        return {
          memorySize: fn.MemorySize,
          timeoutSeconds: fn.Timeout,
          runtime: fn.Runtime,
          handler: fn.Handler,
          architecture: fn.Architectures?.[0],
          layers: (fn.Layers ?? []).flatMap((layer) => (layer.Arn ? [layer.Arn] : [])),
          environment,
          vpcConfig:
            subnetIds.length > 0
              ? {
                  subnetIds,
                  securityGroupIds: [...(fn.VpcConfig?.SecurityGroupIds ?? [])].sort(),
                }
              : undefined,
          fileSystemConfigs: fileSystemConfigs.length > 0 ? fileSystemConfigs : undefined,
          tracing: fn.TracingConfig?.Mode,
          codeSha256: fn.CodeSha256,
          functionUrlConfig: urlConfig
            ? {
                authType: urlConfig.AuthType,
                invokeMode: urlConfig.InvokeMode,
                // A cleared CORS config reads back as an empty object.
                cors:
                  cors && Object.values(cors).some((value) => value !== undefined)
                    ? cors
                    : undefined,
              }
            : undefined,
          logRetentionInDays,
          executionRole: {
            managedPolicyArns: attached.sort(),
            inlinePolicies: {
              ...(bindingPolicy === undefined ? {} : { [policyName]: bindingPolicy }),
              ...(guardPolicy === undefined ? {} : { [logGroupGuardPolicyName]: guardPolicy }),
            },
          },
          eventInvokeConfig: invokeConfig,
          durableConfig: fn.DurableConfig
            ? {
                executionTimeout: fn.DurableConfig.ExecutionTimeout,
                retentionPeriodInDays: fn.DurableConfig.RetentionPeriodInDays,
              }
            : undefined,
        } satisfies Partial<Function["Attributes"]>;
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
        return updated.ReservedConcurrentExecutions ?? reservedConcurrentExecutions;
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

        // The precreated stub responds 503 until reconciliation installs the
        // real handler and waits for its configuration to become active.
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

        // A just-created role (or its freshly attached policies, KMS grant
        // principal, or security group) isn't visible to Lambda yet.
        const isRolePropagationError = (
          e:
            | Lambda.CreateFunctionError
            | Lambda.UpdateFunctionCodeError
            | Lambda.UpdateFunctionConfigurationError,
        ) =>
          e._tag === "ExecutionRoleNotAssumable" ||
          e._tag === "ExecutionRoleMissingVpcPermissions" ||
          e._tag === "KmsGrantPrincipalNotReady";

        const isSecurityGroupPropagationError = (e: Lambda.CreateFunctionError) =>
          e._tag === "SecurityGroupNotFound";

        const noteCreateDependencyWait = () =>
          session.note(
            `Waiting for Lambda creation dependencies to propagate: ${functionName} (${Math.ceil((Date.now() - waitStartedAt) / 1000)}s)`,
          );

        const tags = yield* createInternalTags(id);

        const resolveCodeLocation = Effect.gen(function* () {
          if (code.packageType === "Image") {
            return { ImageUri: code.imageUri } as const;
          }
          // Try to use S3 if the assets bucket is available, otherwise fall
          // back to an inline ZipFile.
          const assets = (yield* Effect.serviceOption(Assets)).pipe(Option.getOrUndefined);
          if (!assets) {
            return { ZipFile: code.archive } as const;
          }
          const key = yield* assets.uploadAsset(code.hash, code.archive);
          yield* Effect.logDebug(`Using S3 for code: s3://${yield* assets.bucketName}/${key}`);
          return {
            S3Bucket: yield* assets.bucketName,
            S3Key: key,
          } as const;
        });
        const codeLocation = yield* resolveCodeLocation;
        const runtimeEnv = isFunctionImageProps(news) ? env : withNodeSourceMaps(env, news);
        const lambdaTimeout = yield* lambdaTimeoutOf({
          id,
          timeout: news.timeout,
          timeoutMargin: news.timeoutMargin,
          interrupt: interruptsAtTimeout(news),
        });

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
          // Defaults are explicit so removing the prop (or repairing drift on
          // a function that never set it) converges back to AWS's default;
          // `UpdateFunctionConfiguration` treats omitted fields as "leave as-is".
          MemorySize: news.memorySize ?? 128,
          // Always explicit: `UpdateFunctionConfiguration` treats an omitted
          // `Layers` as "leave as-is", so removing the prop would strand the
          // previously-attached layers.
          Layers: isFunctionImageProps(news)
            ? undefined
            : (news.layers ?? []).map(layerVersionArnOf),
          Environment: {
            Variables: {
              ...runtimeEnv,
              ...alchemyEnv,
              ...timeoutGraceEnv(lambdaTimeout.graceMs),
              ...responseStreamEnv(news.functionUrl),
            },
          },
          Tags: tags,
          Timeout: lambdaTimeout.timeoutSeconds,
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

        // Update an existing function in place. Only an engine-admitted
        // function reaches this directly — see `preferUpdate`.
        const update = Effect.gen(function* () {
          yield* Effect.logDebug(`updating function code ${id}`);
          yield* Lambda.updateFunctionCode({
            FunctionName: createFunctionRequest.FunctionName,
            Architectures: createFunctionRequest.Architectures,
            ...codeLocation,
          }).pipe(
            Effect.tapError((e) =>
              isRolePropagationError(e) ? noteCreateDependencyWait() : Effect.void,
            ),
            Effect.retry({
              while: (e) => e._tag === "ResourceConflictException" || isRolePropagationError(e),
              schedule: Schedule.exponential(100),
            }),
          );
          yield* Effect.logDebug(`updated function code ${id}`);
          const configured = yield* Lambda.updateFunctionConfiguration({
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
              isRolePropagationError(e) ? noteCreateDependencyWait() : Effect.void,
            ),
            Effect.retry({
              while: (e) => e._tag === "ResourceConflictException" || isRolePropagationError(e),
              schedule: Schedule.exponential(100),
            }),
          );
          yield* Effect.logDebug(`updated function configuration ${id}`);
          // An adopted function still carries its previous owner's tags.
          // Brand it from the observed tags, keeping any added out-of-band.
          if (configured.FunctionArn !== undefined) {
            const observed = yield* Lambda.listTags({ Resource: configured.FunctionArn });
            if (!hasTags(tags, observed.Tags ?? {})) {
              yield* Lambda.tagResource({ Resource: configured.FunctionArn, Tags: tags });
            }
          }
        }) as Effect.Effect<any, any, Credentials | Region | HttpClient>;

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
                  Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(false)),
                ),
          ),
          Effect.filterOrFail(
            (owned) => owned,
            () =>
              // TODO(sam): add custom
              new Error("Function tags do not match expected values"),
          ),
          Effect.andThen(update),
        ) as Effect.Effect<any, any, Credentials | Region | HttpClient>;

        const create = Lambda.createFunction(createFunctionRequest).pipe(
          Effect.tapError((e) => Effect.logDebug(e)),
          Effect.retry({
            while: (e) => isRolePropagationError(e) || isSecurityGroupPropagationError(e),
            schedule: Schedule.fixed(1000).pipe(Schedule.tap(() => noteCreateDependencyWait())),
          }),
          Effect.catchTags({
            ResourceConflictException: () => getAndUpdate,
          }),
        ) as Effect.Effect<any, any, Credentials | Region | HttpClient>;

        if (preferUpdate) {
          // The engine has admitted this function (`read`/`observe`, or
          // `--adopt`), so a foreign tag set is no reason to refuse.
          yield* update.pipe(
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
        qualifier: string | undefined,
      ) {
        yield* Effect.all(
          [
            Lambda.removePermission({
              FunctionName: functionName,
              Qualifier: qualifier,
              StatementId: publicUrlAccessStatementId,
            }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
            Lambda.removePermission({
              FunctionName: functionName,
              Qualifier: qualifier,
              StatementId: publicUrlInvokeStatementId,
            }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
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
                Qualifier: permission.Qualifier,
                StatementId: permission.StatementId,
              }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
              yield* Lambda.addPermission(permission);
            }),
          ),
          retryFunctionMutation,
        );

      const upsertPublicFunctionUrlPermissions = Effect.fn(function* (
        functionName: string,
        qualifier: string | undefined,
      ) {
        yield* Effect.all(
          [
            upsertPermission({
              FunctionName: functionName,
              Qualifier: qualifier,
              StatementId: publicUrlAccessStatementId,
              Action: "lambda:InvokeFunctionUrl",
              Principal: "*",
              FunctionUrlAuthType: "NONE",
            }),
            upsertPermission({
              FunctionName: functionName,
              Qualifier: qualifier,
              StatementId: publicUrlInvokeStatementId,
              Action: "lambda:InvokeFunction",
              Principal: "*",
              InvokedViaFunctionUrl: true,
            }),
          ],
          { concurrency: "unbounded" },
        );
      });

      const deleteFunctionUrl = Effect.fn(function* (
        functionName: string,
        qualifier: string | undefined,
      ) {
        yield* Effect.logDebug(`deleting function url config ${functionName}`);
        yield* Effect.all([
          Lambda.deleteFunctionUrlConfig({
            FunctionName: functionName,
            Qualifier: qualifier,
          }).pipe(
            retryFunctionMutation,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          ),
          removePublicFunctionUrlPermissions(functionName, qualifier),
        ]);
        yield* Effect.logDebug(`deleted function url config ${functionName}`);
      });

      const createOrUpdateFunctionUrl = Effect.fn(function* ({
        functionName,
        qualifier,
        previousQualifier,
        url,
        oldUrl,
        currentFunctionUrl,
      }: {
        functionName: string;
        /** Alias the URL is attached to; `undefined` for the unqualified function. */
        qualifier: string | undefined;
        /** Alias the URL was attached to before this reconcile. */
        previousQualifier: string | undefined;
        url: FunctionProps["functionUrl"];
        oldUrl?: FunctionProps["functionUrl"];
        currentFunctionUrl?: string;
      }) {
        const desired = normalizeFunctionUrl(url);
        const previous = normalizeFunctionUrl(oldUrl);
        const hadFunctionUrl = previous !== undefined || !!currentFunctionUrl;

        // A URL config belongs to one qualifier. Moving between the
        // unqualified function and an alias (or between aliases) retires the
        // old URL and its public permissions before the new one is created.
        if (hadFunctionUrl && previousQualifier !== qualifier) {
          yield* deleteFunctionUrl(functionName, previousQualifier);
        }

        if (desired) {
          yield* Effect.logDebug(`creating function url config ${functionName}`);
          const shouldClearCors = desired.cors === undefined && previous?.cors !== undefined;
          const config = {
            FunctionName: functionName,
            Qualifier: qualifier,
            AuthType: desired.authType,
            Cors: desired.cors ?? (shouldClearCors ? {} : undefined),
            InvokeMode: desired.invokeMode,
          } satisfies Lambda.CreateFunctionUrlConfigRequest | Lambda.UpdateFunctionUrlConfigRequest;
          const { FunctionUrl } = yield* Lambda.createFunctionUrlConfig(config).pipe(
            Effect.catchTag("ResourceConflictException", () =>
              // An omitted Cors leaves the URL's CORS as-is; clear it so CORS
              // added out-of-band is removed.
              Lambda.updateFunctionUrlConfig({ ...config, Cors: config.Cors ?? {} }),
            ),
            retryFunctionMutation,
          );

          if (desired.authType === "NONE") {
            yield* upsertPublicFunctionUrlPermissions(functionName, qualifier);
          } else {
            yield* removePublicFunctionUrlPermissions(functionName, qualifier);
          }

          yield* Effect.logDebug(`created function url config ${functionName}`);
          return FunctionUrl;
        } else if (hadFunctionUrl) {
          yield* deleteFunctionUrl(functionName, qualifier);
        }
        return undefined;
      });

      /**
       * Publish the settled `$LATEST` as a version and point `alias` at it.
       * Lambda hands back the latest version when nothing changed since it
       * was published, so an unchanged deploy publishes nothing new.
       */
      const syncAlias = Effect.fn(function* ({
        functionName,
        functionArn,
        alias,
      }: {
        functionName: string;
        functionArn: string;
        alias: string;
      }) {
        const deleteHint = `Delete versions no alias serves (\`aws lambda list-versions-by-function --function-name ${functionName}\`, then \`aws lambda delete-function --function-name ${functionName} --qualifier <version>\`)`;
        const published = yield* Lambda.publishVersion({ FunctionName: functionName }).pipe(
          retryFunctionMutation,
          Effect.catchTags({
            CodeStorageExceededException: (cause) =>
              Effect.fail(
                new FunctionAliasPublishFailed({
                  functionName,
                  alias,
                  reason: "CodeStorageExceeded",
                  message: `Cannot publish a version of ${functionName} for alias "${alias}": the account's Lambda code storage quota is full (${cause.message ?? "CodeStorageExceededException"}). Published versions are retained. ${deleteHint} or request a code storage quota increase.`,
                }),
              ),
            FunctionVersionsPerCapacityProviderLimitExceededException: (cause) =>
              Effect.fail(
                new FunctionAliasPublishFailed({
                  functionName,
                  alias,
                  reason: "VersionLimitExceeded",
                  message: `Cannot publish a version of ${functionName} for alias "${alias}": its capacity provider has reached its version limit (${cause.message ?? "FunctionVersionsPerCapacityProviderLimitExceededException"}). ${deleteHint}.`,
                }),
              ),
          }),
        );
        const version = published.Version!;
        const desired = {
          FunctionName: functionName,
          Name: alias,
          FunctionVersion: version,
          // Clears weights another tool may have added; the alias serves
          // exactly the version this deploy published.
          RoutingConfig: { AdditionalVersionWeights: {} },
        };
        const observed = yield* Lambda.getAlias({ FunctionName: functionName, Name: alias }).pipe(
          Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
        );
        if (observed === undefined) {
          yield* Lambda.createAlias({
            FunctionName: functionName,
            Name: alias,
            FunctionVersion: version,
          }).pipe(
            // Created by a concurrent or interrupted reconcile.
            Effect.catchTag("ResourceConflictException", () => Lambda.updateAlias(desired)),
            retryFunctionMutation,
            Effect.catchTag("AliasLimitExceededException", (cause) =>
              Effect.fail(
                new FunctionAliasPublishFailed({
                  functionName,
                  alias,
                  reason: "AliasLimitExceeded",
                  message: `Cannot create alias "${alias}" on ${functionName}: the function has reached Lambda's alias limit (${cause.message ?? "AliasLimitExceededException"}). Delete aliases it no longer uses (\`aws lambda list-aliases --function-name ${functionName}\`, then \`aws lambda delete-alias --function-name ${functionName} --name <alias>\`).`,
                }),
              ),
            ),
          );
        } else if (
          observed.FunctionVersion !== version ||
          Object.keys(observed.RoutingConfig?.AdditionalVersionWeights ?? {}).length > 0
        ) {
          yield* Lambda.updateAlias(desired).pipe(retryFunctionMutation);
        }
        return { version, qualifiedArn: `${functionArn}:${alias}` };
      });

      const deleteAlias = (functionName: string, alias: string) =>
        Lambda.deleteAlias({ FunctionName: functionName, Name: alias }).pipe(
          retryFunctionMutation,
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        );

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
            ...(observed?.ImageUri === undefined ? {} : { imageUri: observed.ImageUri }),
            ...(resolvedImageUri === undefined ? {} : { resolvedImageUri }),
            ...(digest === undefined ? {} : { digest }),
          },
        };
      };

      return {
        stables: ["functionArn", "functionName", "roleName", "qualifiedArn", "aliasName"],
        diff: Effect.fn(function* ({ id, olds, news: desired, output, oldBindings, newBindings }) {
          // Effect-native runtime exports remain unevaluated during planning.
          // Their identity is represented by the bundle hash, so they must not
          // prevent source changes from reaching the hash comparison below.
          const news =
            typeof desired === "object" && desired !== null && "exports" in desired
              ? ({
                  ...desired,
                  exports: stripEffects(desired.exports),
                } as typeof desired)
              : desired;
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
          if (olds.alias !== news.alias) {
            // Consumers move to (or off) the alias: its ARN is not known
            // until reconcile publishes and creates it.
            return { action: "update", stables: ["functionArn", "functionName", "roleName"] };
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
            imageIdentity = yield* functionImage.identity(id, news.image, news.architecture);
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
                  !(yield* functionImage.isReady(id, image.repositoryName, codeHash)))
            ) {
              return { action: "update" };
            }
            if (
              isFunctionImageProps(olds) &&
              !deepEqual(toLambdaImageConfig(olds.image), toLambdaImageConfig(news.image))
            ) {
              return { action: "update" };
            }
          }
          if (toDurationMillis(olds.timeout) !== toDurationMillis(news.timeout)) {
            return { action: "update" };
          }
          if (toDurationMillis(olds.timeoutMargin) !== toDurationMillis(news.timeoutMargin)) {
            return { action: "update" };
          }
          if (olds.architecture !== news.architecture) {
            return { action: "update" };
          }
          if (olds.reservedConcurrentExecutions !== news.reservedConcurrentExecutions) {
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
            // Bindings (env / policies from `bind`) are not props. An explicit
            // noop would skip the engine's binding comparison, so defer to it
            // whenever they may have changed.
            if (!isResolved(newBindings) || !deepEqual(oldBindings, newBindings)) {
              return undefined;
            }
            return { action: "noop" };
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const functionName =
            output?.functionName ?? (yield* createFunctionName(id, olds?.functionName));
          yield* Effect.logDebug(`reading function ${functionName}`);
          const result = yield* Lambda.getFunction({
            FunctionName: functionName,
          }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
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
          const aliasName = olds?.alias ?? output?.aliasName;
          const alias = aliasName
            ? yield* Lambda.getAlias({ FunctionName: fn.FunctionName, Name: aliasName }).pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
              )
            : undefined;
          const roleName = output?.roleName ?? fn.Role.split("/").pop()!;
          const observed = yield* observeFunctionConfiguration({
            id,
            configuration: fn,
            qualifier: alias?.Name,
            roleName,
            logging: olds?.logging,
          });
          const functionUrl = yield* readFunctionUrlConfig(fn.FunctionName, alias?.Name).pipe(
            Effect.map((config) => config?.FunctionUrl),
          );
          const reservedConcurrentExecutions = yield* getReservedConcurrentExecutions(
            fn.FunctionName,
          );
          // Reuse the persisted output where we have it (e.g. code hash) so
          // diff doesn't see drift it can't reconstruct from the API.
          const attrs = {
            ...output,
            ...observed,
            functionArn: fn.FunctionArn,
            functionName: fn.FunctionName,
            qualifiedArn: alias?.AliasArn ?? fn.FunctionArn,
            aliasName: alias?.Name,
            version: alias?.FunctionVersion,
            functionUrl,
            roleArn: fn.Role,
            roleName,
            code: refreshPersistedFunctionCode({
              output,
              packageType: fn.PackageType,
              observed: result?.Code,
            }),
            reservedConcurrentExecutions,
          } satisfies Function["Attributes"];
          return (yield* hasAlchemyTags(id, tagsResult)) ? attrs : Unowned(attrs);
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
                    Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
                  );
                  const reservedConcurrentExecutions = yield* getReservedConcurrentExecutions(
                    fn.FunctionName,
                  );
                  return {
                    functionArn: fn.FunctionArn,
                    functionName: fn.FunctionName,
                    qualifiedArn: fn.FunctionArn,
                    functionUrl,
                    roleArn: fn.Role,
                    roleName: fn.Role.split("/").pop()!,
                    code: { hash: "" },
                    ...(reservedConcurrentExecutions === undefined
                      ? {}
                      : { reservedConcurrentExecutions }),
                    ...(fn.MemorySize === undefined ? {} : { memorySize: fn.MemorySize }),
                    ...(fn.Timeout === undefined ? {} : { timeoutSeconds: fn.Timeout }),
                  } satisfies Function["Attributes"];
                }),
              { concurrency: 10 },
            );
            return rows.filter((row): row is Function["Attributes"] => row !== undefined);
          }),

        observe: Effect.fn(function* ({ id, news }) {
          // Precreate creates — or updates — the function named here. Its
          // execution role is named from the logical id alone.
          if (!isResolved(news.functionName)) return Unresolved;
          const functionName = yield* createFunctionName(id, news.functionName);
          const result = yield* Lambda.getFunction({ FunctionName: functionName }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
          );
          const functionArn = result?.Configuration?.FunctionArn;
          if (functionArn === undefined) return undefined;
          const tags = yield* Lambda.listTags({ Resource: functionArn }).pipe(
            Effect.map((r) => r.Tags ?? {}),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({} as Record<string, string>),
            ),
          );
          const observed = { functionArn, functionName };
          return (yield* hasAlchemyTags(id, tags)) ? observed : Unowned(observed);
        }),
        precreate: Effect.fn(function* ({ id, news, session }) {
          if (!isResolved(news.functionName)) {
            return yield* new UnresolvedIdentity({
              message:
                `Function(${id}): \`functionName\` depends on a resource in this ` +
                "Function's dependency cycle, so precreate cannot name the function. " +
                "Use a literal name, or one from outside the cycle.",
              resourceType: "AWS.Lambda.Function",
              logicalId: id,
            });
          }
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
          const { roleName, functionName, roleArn } = yield* createNames(id, news.functionName);

          const role = yield* createRoleIfNotExists({
            id,
            roleName,
            vpc: news.vpc,
          });
          yield* syncLogGroupGuard({ roleName, functionName });
          yield* ensureLogGroup({ id, functionName, retention: news.logging?.retention });

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
            // `observe` (or `read`) has already admitted an existing function.
            preferUpdate: true,
          });

          const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${functionName}`;
          // Consumers in a cycle with this Function wire the alias before
          // reconcile runs, so the alias must already exist (serving the
          // stub until reconcile advances it).
          const alias =
            typeof news.alias === "string"
              ? yield* syncAlias({ functionName, functionArn, alias: news.alias })
              : undefined;

          return {
            functionArn,
            functionName,
            qualifiedArn: alias?.qualifiedArn ?? functionArn,
            aliasName: alias === undefined ? undefined : news.alias,
            version: alias?.version,
            functionUrl: undefined,
            roleName,
            code: prepared.attributes,
            roleArn,
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, bindings, output, session }) {
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
          yield* syncLogGroupGuard({ roleName, functionName });
          yield* ensureLogGroup({ id, functionName, retention: news.logging?.retention });

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
                    ...new Set([...(news.vpc?.subnetIds ?? []), ...(bindingVpc?.subnetIds ?? [])]),
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
              PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
            });
          }

          yield* syncTracingPolicy({
            roleName,
            tracing: news.tracing,
            // Routine update from Active, or adoption (output without olds)
            // where the prior tracing mode is unknown.
            mayHaveBeenActive:
              olds?.tracing === "Active" || (olds === undefined && output !== undefined),
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
              PolicyArn: "arn:aws:iam::aws:policy/AmazonElasticFileSystemClientReadWriteAccess",
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
            // On update an omitted VpcConfig means "leave as-is"; detach
            // explicitly so a VPC attached out-of-band is removed.
            vpc:
              vpc ?? (output !== undefined ? { subnetIds: [], securityGroupIds: [] } : undefined),
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
          }).pipe(
            Effect.andThen(waitForFunctionUpdate(functionName, session, vpc !== undefined)),
            // The create/update call can succeed while Lambda's ASYNC
            // provisioning (VPC ENIs, EFS mounts) still fails with
            // `InsufficientRolePermissions` — "The function's execution role
            // doesn't have permission to perform this operation." — because
            // the just-attached AWSLambdaVPCAccessExecutionRole /
            // EFS client policy has not propagated yet. That is IAM eventual
            // consistency, not a misconfiguration: re-apply the function
            // (the create path falls through to update on conflict, which
            // re-triggers provisioning) and wait again, bounded.
            Effect.tapError((e) =>
              e._tag === "FunctionUpdateFailed" && e.reasonCode === "InsufficientRolePermissions"
                ? session.note(
                    `Waiting for Lambda execution role permissions to propagate: ${functionName}`,
                  )
                : Effect.void,
            ),
            Effect.retry({
              while: (e) =>
                e._tag === "FunctionUpdateFailed" && e.reasonCode === "InsufficientRolePermissions",
              schedule: Schedule.spaced("10 seconds"),
              times: 6,
            }),
          );

          const previousImage = output?.code.image;
          const nextImage = "image" in prepared.attributes ? prepared.attributes.image : undefined;
          if (
            previousImage?.ownsRepository === true &&
            previousImage.repositoryUri !== nextImage?.repositoryUri
          ) {
            // Lambda has adopted the new image; the previous managed
            // repository is no longer referenced.
            yield* functionImage.deleteRepository(previousImage.repositoryName);
          }

          const reservedConcurrentExecutions = yield* syncReservedConcurrentExecutions({
            functionName,
            reservedConcurrentExecutions: news.reservedConcurrentExecutions,
          });

          // With an alias, every consumer invokes the alias: publish the
          // settled code as a version and advance the alias before the URL
          // and async-invoke config are attached to it.
          const alias = news.alias
            ? yield* syncAlias({ functionName, functionArn, alias: news.alias })
            : undefined;
          const previousAlias = output?.aliasName;

          yield* syncEventInvokeConfig({
            functionName,
            qualifier: news.alias,
            config: news.eventInvokeConfig,
          });
          if (news.alias) {
            // The config moved to the alias; `$LATEST` falls back to defaults.
            yield* syncEventInvokeConfig({ functionName, config: undefined });
          }

          const functionUrl = yield* createOrUpdateFunctionUrl({
            functionName,
            qualifier: news.alias,
            previousQualifier: previousAlias,
            url: news.functionUrl,
            oldUrl: olds?.functionUrl,
            currentFunctionUrl: output?.functionUrl,
          });

          // Consumers and the URL have moved off the previous alias.
          if (previousAlias !== undefined && previousAlias !== news.alias) {
            yield* deleteAlias(functionName, previousAlias);
          }

          yield* session.note(summary(prepared.deployment));

          // Re-read rather than reuse the create/update response, which omits
          // settings such as `DurableConfig` that `read` observes.
          const observed = yield* observeFunctionConfiguration({
            id,
            configuration: yield* Lambda.getFunctionConfiguration({ FunctionName: functionName }),
            qualifier: news.alias,
            roleName,
            logging: news.logging,
          });

          return {
            ...output,
            functionArn,
            functionName,
            qualifiedArn: alias?.qualifiedArn ?? functionArn,
            aliasName: news.alias,
            version: alias?.version,
            functionUrl: functionUrl as any,
            domainUrl: functionDomainUrl(news.domain),
            roleName,
            roleArn,
            code: prepared.attributes,
            reservedConcurrentExecutions,
            ...observed,
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
                Effect.forEach(
                  // The log-group guard stays until the function is deleted.
                  (policies.PolicyNames ?? []).filter(
                    (policyName) => policyName !== logGroupGuardPolicyName,
                  ),
                  (policyName) =>
                    iam
                      .deleteRolePolicy({
                        RoleName: output.roleName,
                        PolicyName: policyName,
                      })
                      .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void)),
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
                Effect.forEach(policies.AttachedPolicies ?? [], (policy) =>
                  iam
                    .detachRolePolicy({
                      RoleName: output.roleName,
                      PolicyArn: policy.PolicyArn!,
                    })
                    .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void)),
                ),
              ),
              Effect.catchTag("NoSuchEntityException", () => Effect.void),
            );

          yield* Lambda.deleteFunction({
            FunctionName: output.functionName,
          }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));

          if (output.code.image?.ownsRepository) {
            // Lambda must release its image before the owned repository is
            // force-deleted. Both operations are idempotent, so an interrupted
            // destroy converges on the next run.
            yield* functionImage.deleteRepository(output.code.image.repositoryName);
          }

          // The managed policies were detached before deleteFunction, so the
          // role no longer allows logs:CreateLogGroup and the guard can go with
          // it. IAM can briefly report a just-detached role as still in use, so
          // retry those eventual-consistency conflicts on a bounded schedule.
          yield* iam
            .deleteRolePolicy({ RoleName: output.roleName, PolicyName: logGroupGuardPolicyName })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
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

          // Alchemy created /aws/lambda/<name> and the role could never
          // create it (see `syncLogGroupGuard`), so a late log flush after
          // deleteFunction is dropped instead of re-creating the group: one
          // delete is enough.
          yield* logs
            .deleteLogGroup({ logGroupName: `/aws/lambda/${output.functionName}` })
            .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));

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
                  const lines: LogLine[] = (event.sessionUpdate.sessionResults ?? []).flatMap(
                    (result) => {
                      if (!result.message) return [];
                      return [
                        {
                          timestamp: new Date(result.timestamp ?? Date.now()),
                          message: result.message.trimEnd(),
                        },
                      ];
                    },
                  );
                  return Stream.fromIterable(lines);
                }
                return Stream.empty;
              }),
            );
          });

          return Stream.unwrap(runTailSession).pipe(Stream.retry(Schedule.spaced("1 second")));
        },
        logs: ({ output, options }: { output: Function["Attributes"]; options: LogsInput }) =>
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
              Effect.catchTag("ResourceNotFoundException", () => Effect.succeed([] as LogLine[])),
            ),
      };
    }),
  );
