import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as iam from "@distilled.cloud/aws/iam";
import * as LambdaWeb from "@distilled.cloud/aws/lambda-web";
import type { Region } from "@distilled.cloud/aws/Region";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, havePropsChanged, isResolved, stripEffects } from "alchemy/Diff";
import * as Output from "alchemy/Output";
import { createPhysicalName } from "alchemy/PhysicalName";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import type { LogLine, LogsInput } from "alchemy/Provider";
import * as Provider from "alchemy/Provider";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import { createHostRuntimeContext, type HostRuntimeContext } from "alchemy/Runtime/Process";
import { Stack } from "alchemy/Stack";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Assets, ensureLambdaWebCodeAccess } from "../Assets.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { PolicyDocument, PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import type { FunctionBuildOptions, FunctionZipProps } from "./Function.ts";
import { makeFunctionBundler, type FunctionBundleOptions } from "./FunctionBundle.ts";
import type { NetworkConnectorProps } from "./NetworkConnector.ts";
import { createConnector, getConnector, syncConnector } from "./NetworkConnectorLifecycle.ts";
import {
  connectorOfRevision,
  deleteConnectorAndRole,
  deleteOperatorRole,
  EGRESS_POLICY,
  releaseEgressConnector,
  sameConnector,
} from "./WebFunctionEgress.ts";
import {
  createEndpointConfig,
  deleteEndpoint,
  endpointTypeOf,
  endpointLimits,
  getEndpoint,
  latestRevisionId,
  servedRevisions,
  syncEndpoint,
  validateWebFunctionSettings,
  WebFunctionFailed,
  WebFunctionNotReady,
  type WebFunctionAuthType,
  type WebFunctionCanary,
  type WebFunctionEndpointSpec,
  type WebFunctionEndpointType,
  type WebFunctionRevisionWeight,
} from "./WebFunctionEndpointSync.ts";

export type {
  WebFunctionAuthType,
  WebFunctionCanary,
  WebFunctionEndpointType,
  WebFunctionRevisionWeight,
} from "./WebFunctionEndpointSync.ts";

export const WebFunctionTypeId = "AWS.Lambda.WebFunction" as const;
export type WebFunctionTypeId = typeof WebFunctionTypeId;

/** Name of the built-in endpoint unless `endpointName` is set. */
const DEFAULT_ENDPOINT_NAME = "default";

/** Entry file inside the archive (see `zipCode`). */
const ENTRY_FILE = "index.mjs";

/** Inline policy denying the execution role `logs:CreateLogGroup` on its own groups. */
const LOG_GROUP_GUARD_POLICY = "AlchemyDenyLogGroupCreate";

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_CONCURRENCY = 64;

export const isWebFunction = (value: unknown): value is WebFunction =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  (value as { Type?: unknown }).Type === WebFunctionTypeId;

/** Subnets and security groups for a Web Function's outbound VPC traffic. */
export interface WebFunctionVpc {
  /** Subnets the connector creates network interfaces in. */
  subnetIds: string[];
  /** Security groups applied to the connector's network interfaces. */
  securityGroupIds: string[];
}

/** `vpc` was combined with `regions`; VPC egress works only in the home Region. */
export class WebFunctionVpcRequiresHomeRegion extends Data.TaggedError(
  "WebFunctionVpcRequiresHomeRegion",
)<{ functionId: string; message: string }> {}

export interface WebFunctionProps extends PlatformProps {
  /**
   * Entry module of the web server.
   *
   * With an Effect implementation (the class form), Alchemy serves the
   * returned `fetch` handler. Without one, `main` is your own Node server
   * and is bundled as-is: it must listen on the `host:port` Lambda passes
   * in `AWS_LAMBDA_HTTP_ENDPOINT`.
   */
  main: string;
  /**
   * Set to `false` to skip bundling and deploy `main`'s directory as-is,
   * e.g. a framework's standalone server output (`.output/server`,
   * Next.js `.next/standalone`). Lambda starts `main`, which must listen
   * on `AWS_LAMBDA_HTTP_ENDPOINT`.
   * @default true
   */
  bundle?: false;
  /**
   * Name of the Web Function. If omitted, a unique name is generated from
   * the stack, stage, and logical ID. Changing it replaces the function.
   */
  functionName?: string;
  /**
   * Description recorded on each revision.
   */
  description?: string;
  /**
   * Node.js runtime of the revision. Web Functions run on Arm64.
   * @default "nodejs24.x"
   */
  runtime?: "nodejs24.x";
  /**
   * Environment variables available to the server. Each change creates a
   * new revision.
   */
  env?: Record<string, any>;
  /**
   * Maximum time a single HTTP request can run, rounded up to whole
   * seconds. Valid range: 3 seconds to 15 minutes.
   * @default 30 seconds
   */
  timeout?: Duration.Duration;
  /**
   * Upper bound on concurrent HTTP requests per execution environment.
   * Lambda manages a dynamic per-environment limit that can be lower, but
   * never exceeds this value. This is not a total: the endpoint's peak is
   * `maxEnvironments × maxConcurrencyPerEnvironment`. Valid range: 1–128.
   * Lower it for CPU- or memory-bound servers: every environment has a
   * fixed 2 GB of memory and 2 vCPUs. Changing it creates a new revision.
   * @default 64
   */
  maxConcurrencyPerEnvironment?: number;
  /**
   * Who may call the built-in endpoint. `"ApplicationManaged"` forwards
   * every request (a public endpoint; authenticate in your application).
   * `"IamAuth"` requires SigV4-signed requests from principals with
   * `lambda:InvokeWebFunctionEndpoint`, such as a CloudFront distribution
   * with origin access control. Changes apply in place.
   */
  authType: WebFunctionAuthType;
  /**
   * Name of the built-in endpoint. Your server receives it in the
   * `lambda-web-endpoint-name` request header. Changing it recreates the
   * endpoint, which gets a new URL.
   * @default "default"
   */
  endpointName?: string;
  /**
   * Additional AWS Regions the built-in endpoint serves from. When set, the
   * endpoint is `MultiRegion`: one global domain with latency-based routing
   * across the home Region and these Regions. Changing it recreates the
   * endpoint, which gets a new URL.
   */
  regions?: string[];
  /**
   * Maximum number of execution environments the built-in endpoint uses per
   * Region (2–10,000). Changes apply in place.
   */
  maxEnvironments?: number;
  /**
   * Maximum requests per second the built-in endpoint accepts, enforced per
   * Region. Excess requests receive HTTP 429; `0` disables the endpoint.
   * Changes apply in place.
   */
  rateLimit?: number;
  /**
   * Roll out deploys gradually on the built-in endpoint: the revision a
   * deploy publishes gets `weight` percent of traffic and the revision it
   * served before keeps the rest. Raise `weight` to shift more traffic,
   * set it to `100` (or remove `canary`) to promote, or `0` to roll back.
   * Each endpoint has its own split.
   */
  canary?: WebFunctionCanary;
  /**
   * Route the server's outbound traffic through your VPC so it can reach
   * private resources such as RDS. Alchemy creates a Lambda network
   * connector (and the operator role Lambda uses to manage its network
   * interfaces) in these subnets and attaches it to every revision. Use at
   * least two subnets in different Availability Zones; private subnets need
   * a NAT gateway to reach the internet. Bindings such as `AWS.RDS.Connect`
   * can request the same access, and both are merged.
   *
   * VPC access works only with single-Region endpoints, so it can't be
   * combined with `regions`. Changing it creates a new revision. Removing
   * it deletes the connector and its operator role once no endpoint serves
   * a revision that uses them.
   */
  vpc?: WebFunctionVpc;
  /**
   * Tags applied to the Web Function.
   */
  tags?: Record<string, string>;
  /**
   * Bundler configuration for {@link main}: rolldown input options,
   * `output` overrides, `install` for native packages (built for Linux
   * Arm64), `pure`, and the bundle analyzer.
   */
  build?: FunctionBuildOptions;
  /**
   * Ship source maps with the bundle and enable `--enable-source-maps`.
   * @default true
   */
  uploadSourceMap?: boolean;
  exports?: string[];
}

export interface WebFunction extends Resource<
  WebFunctionTypeId,
  WebFunctionProps,
  {
    /** Name of the Web Function. */
    functionName: string;
    /** ARN of the Web Function (`arn:aws:lambda:…:web-function/<name>`). */
    functionArn: string;
    /** Name of the built-in endpoint. */
    endpointName: string;
    /** ARN of the built-in endpoint, the resource for `lambda:InvokeWebFunctionEndpoint`. */
    endpointArn: string;
    /** Lambda-allocated domain of the built-in endpoint. */
    domainName: string;
    /** HTTPS URL of the built-in endpoint (`https://<domainName>`). */
    url: string;
    /** Auth type of the built-in endpoint. */
    authType: WebFunctionAuthType;
    /**
     * `HomeRegion`, or `MultiRegion` when `regions` is set: one global
     * domain that routes each request to the nearest Region.
     */
    endpointType: WebFunctionEndpointType;
    /**
     * Revision the latest deploy published. Endpoints route all traffic to
     * it, or `canary.weight` percent while a canary runs.
     */
    revisionId: string;
    /**
     * How the built-in endpoint splits traffic: one revision at 100, or the
     * stable revision and the canary while a canary runs.
     */
    revisionWeights: WebFunctionRevisionWeight[];
    /** Name of the execution role. */
    roleName: string;
    /** ARN of the execution role. */
    roleArn: string;
    code: {
      hash: string;
    };
    /**
     * Requests per second the built-in endpoint allows, as observed. Lets
     * `alchemy drift` detect out-of-band changes.
     */
    rateLimit?: number;
    /**
     * Cap on the built-in endpoint's execution environments, as observed.
     * Lets `alchemy drift` detect out-of-band changes.
     */
    maxEnvironments?: number;
    /**
     * Tags on the web function, as observed. Lets `alchemy drift` detect
     * out-of-band changes.
     */
    tags?: Record<string, string>;
    /**
     * Inline policies Alchemy writes on the execution role (binding grants
     * and the log-group guard), as observed. Lets `alchemy drift` detect
     * out-of-band edits.
     */
    executionRolePolicies?: Record<string, unknown>;
  },
  {
    env?: Record<string, any>;
    policyStatements?: PolicyStatement[];
    /**
     * VPC access requested by a binding (e.g. `AWS.RDS.Connect` with
     * `subnetIds`/`securityGroupIds`). Merged with the `vpc` prop.
     */
    vpc?: WebFunctionVpc;
  },
  Providers
> {}

export type WebFunctionServices = Credentials | Region | AWSEnvironment | WebFunction;

export type WebFunctionShape = Main<WebFunctionServices>;

/** HTTP-only host context: `serve` registers the `fetch` handler. */
export type WebFunctionRuntimeContext = Omit<HostRuntimeContext, "run">;

/**
 * An AWS Lambda Web Function: a serverless HTTP server. Lambda runs your
 * Node.js server in execution environments that each serve many concurrent
 * requests (up to 128), streams responses to the client as they are
 * produced, scales to zero, and gives every function an HTTPS endpoint.
 *
 * Use a Web Function for anything that answers HTTP — APIs, server-rendered
 * apps, streaming AI responses. Use `AWS.Lambda.Function` for event sources
 * (SQS, DynamoDB Streams, S3 notifications, schedules) and direct invokes;
 * a Web Function only receives HTTP. Event sources and background loops
 * (`ServerHost.run`) are type errors in a Web Function and fail at plan.
 * Web Functions launched in `us-east-1`, `us-east-2`, `us-west-2`,
 * `eu-west-1`, and `ap-northeast-1`, and AWS is adding Regions; see the
 * [Lambda pricing page](https://aws.amazon.com/lambda/pricing/) for where
 * they run today. Alchemy doesn't restrict the Region.
 *
 * Every deploy uploads the bundle to the Alchemy assets bucket, creates an
 * immutable revision, and shifts the endpoint's traffic to it. Lambda keeps
 * the 50 most recent revisions.
 *
 * ### Effect Web Functions
 * Return a `fetch` handler. Alchemy serves it with Effect's Node HTTP
 * server on the address Lambda assigns, so streamed `HttpServerResponse`
 * bodies reach the client chunk by chunk. Bindings grant IAM permissions to
 * the function's execution role exactly as on `AWS.Lambda.Function`.
 *
 * **Example:** Effect Web Function with a DynamoDB binding
 * ```typescript
 * // src/api.ts
 * import * as AWS from "@alchemy.run/aws";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export default class Api extends AWS.Lambda.WebFunction<Api>()(
 *   "Api",
 *   { main: import.meta.url, authType: "ApplicationManaged" },
 *   Effect.gen(function* () {
 *     const table = yield* AWS.DynamoDB.Table("Items", {
 *       partitionKey: "pk",
 *       attributes: { pk: "S" },
 *     });
 *     const getItem = yield* AWS.DynamoDB.GetItem(table);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const id = new URL(request.originalUrl).searchParams.get("id")!;
 *         const { Item } = yield* getItem({ Key: { pk: { S: id } } });
 *         return yield* HttpServerResponse.json(Item ?? null);
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.DynamoDB.GetItemHttp)),
 * ) {}
 * ```
 *
 * **Example:** Streaming a response
 * ```typescript
 * export default class Chat extends AWS.Lambda.WebFunction<Chat>()(
 *   "Chat",
 *   { main: import.meta.url, authType: "ApplicationManaged" },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(
 *         HttpServerResponse.stream(
 *           Stream.make("Hello", " from", " Lambda").pipe(
 *             Stream.tap(() => Effect.sleep("100 millis")),
 *             Stream.encodeText,
 *           ),
 *           { contentType: "text/plain" },
 *         ),
 *       ),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Async Web Functions
 * Point `main` at your own Node server. Alchemy bundles it as-is, with no
 * Effect runtime and no wrapper. Listen on the `host:port` Lambda passes in
 * `AWS_LAMBDA_HTTP_ENDPOINT`.
 *
 * **Example:** Hono
 * ```typescript
 * // src/server.ts
 * import { serve } from "@hono/node-server";
 * import { Hono } from "hono";
 *
 * const app = new Hono();
 * app.get("/", (c) => c.text("Hello from Hono"));
 *
 * const [hostname, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "localhost:3000").split(":");
 * serve({ fetch: app.fetch, hostname, port: Number(port) });
 * ```
 *
 * ```typescript
 * // alchemy.run.ts
 * const api = yield* AWS.Lambda.WebFunction("Api", {
 *   main: "./src/server.ts",
 *   authType: "ApplicationManaged",
 * });
 * ```
 *
 * **Example:** Express
 * ```typescript
 * // src/server.ts
 * import express from "express";
 *
 * const app = express();
 * app.get("/", (_req, res) => res.send("Hello from Express"));
 *
 * const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "localhost:3000").split(":");
 * app.listen(Number(port), host);
 * ```
 *
 * **Example:** A framework's standalone server output
 * ```typescript
 * const site = yield* AWS.Lambda.WebFunction("Site", {
 *   main: "./.output/server/index.mjs",
 *   bundle: false,
 *   authType: "ApplicationManaged",
 * });
 * ```
 *
 * ### Configuration
 * **Example:** Concurrency, timeout, and traffic limits
 * ```typescript
 * const api = yield* AWS.Lambda.WebFunction("Api", {
 *   main: "./src/server.ts",
 *   authType: "ApplicationManaged",
 *   maxConcurrencyPerEnvironment: 128,
 *   timeout: Duration.minutes(5),
 *   maxEnvironments: 10,
 *   rateLimit: 500,
 * });
 * ```
 *
 * **Example:** Serving from several Regions behind one domain
 * ```typescript
 * const api = yield* AWS.Lambda.WebFunction("Api", {
 *   main: "./src/server.ts",
 *   authType: "ApplicationManaged",
 *   regions: ["us-east-1", "eu-west-1"],
 * });
 * ```
 *
 * **Example:** Requiring SigV4-signed callers
 * ```typescript
 * const internal = yield* AWS.Lambda.WebFunction("Internal", {
 *   main: "./src/server.ts",
 *   authType: "IamAuth",
 * });
 * ```
 *
 * ### Canary deploys
 * **Example:** Send 10% of traffic to each new deploy
 * ```typescript
 * const api = yield* AWS.Lambda.WebFunction("Api", {
 *   main: "./src/server.ts",
 *   authType: "ApplicationManaged",
 *   // 90% stays on the previous revision. Raise it to shift more, set
 *   // 100 (or remove `canary`) to promote, or 0 to roll back.
 *   canary: { weight: 10 },
 * });
 *
 * api.revisionWeights; // [{ revisionId: "<previous>", weight: 90 }, { revisionId: api.revisionId, weight: 10 }]
 * ```
 *
 * Put CloudFront in front with a `CloudFront.Distribution` origin
 * `{ webFunction: internal }`, which grants only that distribution access.
 * Grant other callers with `AWS.Lambda.WebFunctionPermission`.
 *
 * ### Private network access
 * Set `vpc` to send the server's outbound traffic through your VPC, for
 * example to reach an RDS database in private subnets. Alchemy creates and
 * manages the Lambda network connector this needs.
 *
 * **Example:** Reaching resources in private subnets
 * ```typescript
 * const network = yield* AWS.EC2.Network("Network", {
 *   cidrBlock: "10.0.0.0/16",
 *   nat: "single",
 * });
 * const appSg = yield* AWS.EC2.SecurityGroup("AppSg", { vpcId: network.vpcId });
 *
 * const api = yield* AWS.Lambda.WebFunction("Api", {
 *   main: "./src/server.ts",
 *   authType: "ApplicationManaged",
 *   vpc: {
 *     subnetIds: network.privateSubnetIds,
 *     securityGroupIds: [appSg.groupId],
 *   },
 * });
 * ```
 *
 * ### Additional endpoints
 * The settings above configure the function's built-in endpoint, whose
 * domain is `url`. Add more endpoints, each with its own URL, auth, and
 * limits, with `AWS.Lambda.WebFunctionEndpoint`. All endpoints serve the
 * same code; your server tells them apart by the `lambda-web-endpoint-name`
 * request header.
 *
 * **Example:** A private endpoint for CloudFront and a public one for webhooks
 * ```typescript
 * const api = yield* AWS.Lambda.WebFunction("Api", {
 *   main: "./src/server.ts",
 *   authType: "IamAuth",
 *   maxEnvironments: 50,
 * });
 *
 * const webhooks = yield* AWS.Lambda.WebFunctionEndpoint("Webhooks", {
 *   function: api,
 *   authType: "ApplicationManaged",
 *   rateLimit: 100,
 * });
 * ```
 *
 * For a class-form Web Function, pass the class: `function: Api`.
 *
 * @resource
 */
/** `vpc` and `regions` together: VPC egress needs a single-Region endpoint. */
const requireHomeRegion = (
  id: string,
  vpc: WebFunctionVpc | undefined,
  regions: string[] | undefined,
) =>
  vpc !== undefined && regions !== undefined && regions.length > 0
    ? Effect.fail(
        new WebFunctionVpcRequiresHomeRegion({
          functionId: id,
          message: `AWS.Lambda.WebFunction "${id}": \`vpc\` can't be combined with \`regions\`: Lambda routes VPC egress only for single-Region endpoints`,
        }),
      )
    : Effect.void;

/** The settings Lambda limits, as numbers (Outputs resolve at deploy). */
const checkWebFunctionProps = (id: string, props: WebFunctionProps) =>
  Effect.gen(function* () {
    const number = (value: unknown) => (typeof value === "number" ? value : undefined);
    yield* requireHomeRegion(
      id,
      props.vpc,
      Array.isArray(props.regions) ? props.regions : undefined,
    );
    yield* validateWebFunctionSettings(`AWS.Lambda.WebFunction "${id}"`, {
      rateLimit: number(props.rateLimit),
      maxEnvironments: number(props.maxEnvironments),
      maxConcurrencyPerEnvironment: number(props.maxConcurrencyPerEnvironment),
      timeoutSeconds:
        props.timeout === undefined || Output.isOutput(props.timeout)
          ? undefined
          : toTimeoutSeconds(props.timeout),
      canary:
        props.canary === undefined || number(props.canary.weight) === undefined
          ? undefined
          : props.canary,
    });
  });

export const WebFunction: Platform<
  WebFunction,
  WebFunctionServices,
  WebFunctionShape,
  WebFunctionRuntimeContext,
  {},
  WebFunctionProps
> = Platform(WebFunctionTypeId, {
  // Check limits where the function is declared, so a first deploy fails
  // at plan too (the provider's diff only runs once state exists).
  transformProps: (id: string, props: WebFunctionProps) =>
    globalThis.__ALCHEMY_RUNTIME__
      ? Effect.succeed(props)
      : checkWebFunctionProps(id, props).pipe(Effect.as(props)),
  createRuntimeContext: (id: string): WebFunctionRuntimeContext => {
    // No `run`: environments exist only while HTTP traffic keeps them warm,
    // so background loops (e.g. queue pollers via `ServerHost`) would stop
    // at scale-to-zero and multiply per environment. Without `run`, the
    // platform never provides `ServerHost`, and such code fails to type
    // check and fails at plan instead of deploying a poller that silently
    // stops consuming.
    const { run: _run, ...context } = createHostRuntimeContext(WebFunctionTypeId)(id);
    return context;
  },
});

/** Generated entry for Effect web functions. */
const effectEntry = (importPath: string) => `
import { bootstrap } from "@alchemy.run/aws/Bootstrap/LambdaWeb";
import entrypoint from ${JSON.stringify(importPath)};

bootstrap(entrypoint);
`;

const mainBasename = (main: string) =>
  main.slice(Math.max(main.lastIndexOf("/"), main.lastIndexOf("\\")) + 1);

/** Only the Effect form gets a generated entry; async servers ship as-is. */
const bundleOptions: FunctionBundleOptions = { entry: effectEntry };

/** The bundler reads the Event Function zip props; Web Functions run on Arm64. */
const toZipProps = (props: WebFunctionProps): FunctionZipProps =>
  ({ ...props, architecture: "arm64" }) as FunctionZipProps;

const toTimeoutSeconds = (timeout: Duration.Duration | undefined): number => {
  if (timeout === undefined) return DEFAULT_TIMEOUT_SECONDS;
  // State JSON flattens a Duration to its `toJSON` shape.
  const json = timeout as { _id?: unknown; _tag?: string; millis?: number; nanos?: string };
  const input: Duration.Input =
    json._id === "Duration"
      ? json._tag === "Millis"
        ? json.millis!
        : json._tag === "Nanos"
          ? BigInt(json.nanos!)
          : "Infinity"
      : timeout;
  return Math.max(1, Math.ceil(Duration.toSeconds(input)));
};

export const WebFunctionProvider = () =>
  Provider.effect(
    WebFunction,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const { bundleCode } = yield* makeFunctionBundler;
      const assets = yield* Assets;

      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
      };

      const bundle = (id: string, props: WebFunctionProps) =>
        bundleCode(id, toZipProps(props), bundleOptions);

      const createNames = Effect.fn(function* (id: string, functionName: string | undefined) {
        return {
          functionName: functionName ?? (yield* createPhysicalName({ id, maxLength: 64 })),
          roleName: yield* createPhysicalName({ id, maxLength: 64 }),
          policyName: yield* createPhysicalName({ id, maxLength: 128 }),
        };
      });

      const ensureRole = Effect.fn(function* (id: string, roleName: string) {
        const existing = yield* iam
          .getRole({ RoleName: roleName })
          .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.undefined));
        const role =
          existing ??
          (yield* iam
            .createRole({
              RoleName: roleName,
              AssumeRolePolicyDocument: JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { Service: "lambda.amazonaws.com" },
                    Action: "sts:AssumeRole",
                  },
                ],
              }),
              Tags: createTagsList(yield* createInternalTags(id)),
            })
            .pipe(
              Effect.catchTag("EntityAlreadyExistsException", () =>
                iam.getRole({ RoleName: roleName }),
              ),
            ));
        yield* iam.attachRolePolicy({
          RoleName: roleName,
          PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        });
        return role.Role.Arn;
      });

      const syncBindings = Effect.fn(function* ({
        roleName,
        policyName,
        bindings,
      }: {
        roleName: string;
        policyName: string;
        bindings: ResourceBinding<WebFunction["Binding"]>[];
      }) {
        const active = bindings.filter(
          (binding: ResourceBinding<WebFunction["Binding"]> & { action?: string }) =>
            binding.action !== "delete",
        );
        const env = active
          .map((binding) => binding?.data?.env)
          .reduce((acc, env) => ({ ...acc, ...env }), {});
        const policyStatements = active.flatMap(
          (binding) =>
            binding?.data?.policyStatements?.map((stmt: PolicyStatement) => ({
              ...stmt,
              Sid: stmt.Sid?.replace(/[^A-Za-z0-9]+/gi, ""),
            })) ?? [],
        );
        const vpcRequests = active.flatMap((binding) =>
          binding?.data?.vpc ? [binding.data.vpc] : [],
        );
        if (policyStatements.length > 0) {
          yield* iam.putRolePolicy({
            RoleName: roleName,
            PolicyName: policyName,
            PolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: policyStatements,
            } satisfies PolicyDocument),
          });
        } else {
          yield* iam
            .deleteRolePolicy({ RoleName: roleName, PolicyName: policyName })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }
        return { env, vpcRequests };
      });

      /** The `vpc` prop and binding requests, merged (set-union). */
      const mergeVpc = (
        prop: WebFunctionVpc | undefined,
        requests: WebFunctionVpc[],
      ): WebFunctionVpc | undefined => {
        const all = [...(prop ? [prop] : []), ...requests];
        return all.length === 0
          ? undefined
          : {
              subnetIds: [...new Set(all.flatMap((v) => v.subnetIds))].sort(),
              securityGroupIds: [...new Set(all.flatMap((v) => v.securityGroupIds))].sort(),
            };
      };

      /** Name shared by the egress connector and its operator role. */
      const egressName = (id: string) =>
        createPhysicalName({ id: `${id}-egress`, maxLength: 64, delimiter: "-" });

      /**
       * The role Lambda assumes to create and tag the connector's network
       * interfaces in your subnets (the permissions AWS documents for Web
       * Function connectors).
       */
      const ensureOperatorRole = Effect.fn(function* (id: string, roleName: string) {
        const existing = yield* iam
          .getRole({ RoleName: roleName })
          .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.undefined));
        const role =
          existing ??
          (yield* iam
            .createRole({
              RoleName: roleName,
              AssumeRolePolicyDocument: JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { Service: "lambda.amazonaws.com" },
                    Action: "sts:AssumeRole",
                  },
                ],
              }),
              Tags: createTagsList(yield* createInternalTags(id)),
            })
            .pipe(
              Effect.catchTag("EntityAlreadyExistsException", () =>
                iam.getRole({ RoleName: roleName }),
              ),
            ));
        yield* iam.putRolePolicy({
          RoleName: roleName,
          PolicyName: EGRESS_POLICY,
          PolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["ec2:CreateNetworkInterface"],
                Resource: [
                  "arn:aws:ec2:*:*:network-interface/*",
                  "arn:aws:ec2:*:*:subnet/*",
                  "arn:aws:ec2:*:*:security-group/*",
                ],
              },
              {
                Effect: "Allow",
                Action: ["ec2:CreateTags"],
                Resource: "arn:aws:ec2:*:*:network-interface/*",
                Condition: {
                  StringEquals: {
                    "ec2:ManagedResourceOperator": "network-connectors.lambda.amazonaws.com",
                  },
                },
              },
            ],
          } satisfies PolicyDocument),
        });
        return role.Role.Arn;
      });

      /**
       * Ensure the egress connector for `vpc` and return the version-qualified
       * ARN a revision references. A config change publishes a new connector
       * version, which the next revision picks up.
       */
      const syncEgress = Effect.fn(function* ({
        id,
        vpc,
        session,
      }: {
        id: string;
        vpc: WebFunctionVpc;
        session: ScopedPlanStatusSession;
      }) {
        const name = yield* egressName(id);
        const operatorRole = yield* ensureOperatorRole(id, name);
        const props: NetworkConnectorProps = {
          subnetIds: vpc.subnetIds,
          securityGroupIds: vpc.securityGroupIds,
          associatedComputeResourceTypes: ["WebFunction"],
          operatorRole,
        };
        const found = yield* getConnector(name);
        const observed = found && found.State !== "DELETE_FAILED" ? found : undefined;
        const connector = observed
          ? yield* syncConnector(observed, name, props, session)
          : yield* createConnector(name, props, id, session);
        return (
          connector.LatestVersionArn ??
          connector.VersionArn ??
          `${connector.Arn}:${connector.LatestVersion ?? connector.Version}`
        );
      });

      /**
       * Delete the egress connector and its operator role, if any. The role
       * goes last: Lambda uses it to remove the connector's interfaces.
       */
      const deleteEgress = Effect.fn(function* (id: string, session: ScopedPlanStatusSession) {
        const name = yield* egressName(id);
        yield* deleteConnectorAndRole(name, session);
        // The role can outlive a connector whose create failed.
        yield* deleteOperatorRole(name);
      });

      const getFunction = (functionName: string) =>
        LambdaWeb.getWebFunction({ functionName }).pipe(
          Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
        );

      const getRevision = (functionName: string, revisionId: string) =>
        LambdaWeb.getWebFunctionRevision({ functionName, revisionId }).pipe(
          Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
        );

      const waitForFunctionActive = (
        functionName: string,
        session: { note: (note: string) => Effect.Effect<void> },
      ) =>
        Effect.gen(function* () {
          const fn = yield* getFunction(functionName);
          if (fn?.state === "Active") return fn;
          if (fn?.state === "Failed") {
            return yield* new WebFunctionFailed({
              functionName,
              resource: "function",
              reason: fn.stateReason,
            });
          }
          return yield* new WebFunctionNotReady({
            functionName,
            resource: "function",
            state: fn?.state,
          });
        }).pipe(
          Effect.tapError((e) =>
            e._tag === "WebFunctionNotReady" ? session.note(e.message) : Effect.void,
          ),
          Effect.retry({
            while: (e) => e._tag === "WebFunctionNotReady",
            schedule: Schedule.spaced("2 seconds"),
            times: 45,
          }),
        );

      const waitForRevisionActive = (
        functionName: string,
        revisionId: string,
        session: { note: (note: string) => Effect.Effect<void> },
      ) =>
        Effect.gen(function* () {
          const revision = yield* getRevision(functionName, revisionId);
          if (revision?.state === "Active") return revision;
          if (revision?.state === "Failed") {
            return yield* new WebFunctionFailed({
              functionName,
              resource: `revision ${revisionId}`,
              reason: [
                revision.stateReason,
                ...(revision.errors ?? []).map(
                  (e) => `${e.attribute}: ${e.errorCode} ${e.errorMessage}`,
                ),
              ].join("; "),
            });
          }
          return yield* new WebFunctionNotReady({
            functionName,
            resource: `revision ${revisionId}`,
            state: revision?.state,
          });
        }).pipe(
          Effect.tapError((e) =>
            e._tag === "WebFunctionNotReady" ? session.note(e.message) : Effect.void,
          ),
          Effect.retry({
            while: (e) => e._tag === "WebFunctionNotReady",
            schedule: Schedule.spaced("2 seconds"),
            times: 60,
          }),
        );

      const waitForFunctionGone = (functionName: string) =>
        Effect.gen(function* () {
          const fn = yield* getFunction(functionName);
          if (fn === undefined) return;
          return yield* new WebFunctionNotReady({
            functionName,
            resource: "function",
            state: fn.state,
          });
        }).pipe(
          Effect.retry({
            while: (e) => e._tag === "WebFunctionNotReady",
            schedule: Schedule.spaced("2 seconds"),
            times: 45,
          }),
        );

      /**
       * Lambda rejects a just-created execution role until IAM propagates
       * it; a concurrent mutation of the same function is a conflict.
       */
      const retryRolePropagation = <A, E extends { _tag: string }, R>(
        effect: Effect.Effect<A, E, R>,
        session: { note: (note: string) => Effect.Effect<void> },
        functionName: string,
      ) =>
        effect.pipe(
          Effect.tapError((e) =>
            e._tag === "ExecutionRoleNotAssumable"
              ? session.note(`Waiting for execution role to propagate: ${functionName}`)
              : Effect.void,
          ),
          Effect.retry({
            while: (e) => e._tag === "ExecutionRoleNotAssumable" || e._tag === "ConflictException",
            schedule: Schedule.spaced("3 seconds"),
            times: 20,
          }),
        );

      /** Observed revision matches the desired build and service config. */
      const revisionMatches = (
        observed: LambdaWeb.GetWebFunctionRevisionResponse,
        desired: LambdaWeb.RevisionConfig,
      ) =>
        observed.state !== "Failed" &&
        observed.buildConfig.codeConfig.s3Object.bucket ===
          desired.buildConfig.codeConfig.s3Object.bucket &&
        observed.buildConfig.codeConfig.s3Object.key ===
          desired.buildConfig.codeConfig.s3Object.key &&
        observed.buildConfig.runtimeConfig.runtime === desired.buildConfig.runtimeConfig.runtime &&
        (observed.description ?? "") === (desired.description ?? "") &&
        observed.serviceConfig.executionRoleArn === desired.serviceConfig.executionRoleArn &&
        (observed.serviceConfig.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) ===
          desired.serviceConfig.timeoutSeconds &&
        (observed.serviceConfig.maxConcurrencyPerEnvironment ?? DEFAULT_MAX_CONCURRENCY) ===
          desired.serviceConfig.maxConcurrencyPerEnvironment &&
        (observed.serviceConfig.egressNetworkConnectorArn ?? undefined) ===
          desired.serviceConfig.egressNetworkConnectorArn &&
        deepEqual(
          observed.serviceConfig.environmentVariables ?? {},
          desired.serviceConfig.environmentVariables ?? {},
        );

      const toAttributes = (
        fn: { functionName: string; functionArn: string },
        endpoint: LambdaWeb.GetWebFunctionEndpointResponse,
        role: { roleName: string; roleArn: string },
        code: WebFunction["Attributes"]["code"],
        revisionId: string,
      ): WebFunction["Attributes"] => ({
        functionName: fn.functionName,
        functionArn: fn.functionArn,
        endpointName: endpoint.endpointName,
        endpointArn: endpoint.endpointArn,
        domainName: endpoint.domainName,
        url: `https://${endpoint.domainName}`,
        authType: endpoint.authType as WebFunctionAuthType,
        endpointType: endpoint.endpointType as WebFunctionEndpointType,
        revisionId,
        revisionWeights: servedRevisions(endpoint),
        roleName: role.roleName,
        roleArn: role.roleArn,
        code,
        ...endpointLimits(endpoint),
      });

      /**
       * Tags and Alchemy's execution-role inline policies, as observed.
       * `read` and `reconcile` share it so a converged function reads
       * unchanged.
       */
      const observeFunctionExtras = Effect.fn(function* ({
        functionArn,
        roleName,
        policyName,
      }: {
        functionArn: string;
        roleName: string;
        policyName: string;
      }) {
        const readInlinePolicy = (PolicyName: string) =>
          iam.getRolePolicy({ RoleName: roleName, PolicyName }).pipe(
            Effect.map((policy): unknown => JSON.parse(decodeURIComponent(policy.PolicyDocument))),
            Effect.catchTag("NoSuchEntityException", () => Effect.undefined),
          );
        const [tags, bindingPolicy, guardPolicy] = yield* Effect.all(
          [
            LambdaWeb.listTags({ resource: functionArn }).pipe(
              Effect.map((r) => tagRecord(r.tags)),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed({} as Record<string, string>),
              ),
            ),
            readInlinePolicy(policyName),
            readInlinePolicy(LOG_GROUP_GUARD_POLICY),
          ],
          { concurrency: "unbounded" },
        );
        return {
          tags,
          executionRolePolicies: {
            ...(bindingPolicy === undefined ? {} : { [policyName]: bindingPolicy }),
            ...(guardPolicy === undefined ? {} : { [LOG_GROUP_GUARD_POLICY]: guardPolicy }),
          },
        };
      });

      const logGroupNames = (functionName: string) => [
        `/aws/lambda/web/${functionName}`,
        `/aws/lambda/web/${functionName}.local`,
      ];

      /**
       * Alchemy owns the home-Region log groups: it creates them before the
       * first request and denies the execution role `logs:CreateLogGroup`
       * on them, so a log flush that lands after `delete` cannot re-create
       * a group that was just removed.
       */
      const syncLogGroups = Effect.fn(function* ({
        id,
        functionName,
        roleName,
      }: {
        id: string;
        functionName: string;
        roleName: string;
      }) {
        const { accountId, region } = yield* AWSEnvironment.current;
        const document = JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Deny",
              Action: "logs:CreateLogGroup",
              Resource: logGroupNames(functionName).map(
                (name) => `arn:aws:logs:${region}:${accountId}:log-group:${name}:*`,
              ),
            },
          ],
        });
        const observed = yield* iam
          .getRolePolicy({ RoleName: roleName, PolicyName: LOG_GROUP_GUARD_POLICY })
          .pipe(
            Effect.map((policy) => decodeURIComponent(policy.PolicyDocument)),
            Effect.catchTag("NoSuchEntityException", () => Effect.undefined),
          );
        if (observed !== document) {
          yield* iam.putRolePolicy({
            RoleName: roleName,
            PolicyName: LOG_GROUP_GUARD_POLICY,
            PolicyDocument: document,
          });
        }
        const tags = yield* createInternalTags(id);
        yield* Effect.forEach(logGroupNames(functionName), (logGroupName) =>
          logs
            .createLogGroup({ logGroupName, tags })
            .pipe(Effect.catchTag("ResourceAlreadyExistsException", () => Effect.void)),
        );
      });

      return {
        stables: ["functionArn", "functionName", "roleName"],
        diff: Effect.fn(function* ({ id, olds, news: desired, output, oldBindings, newBindings }) {
          // Effect-native runtime exports remain unevaluated during
          // planning; the bundle hash below represents them.
          const news =
            typeof desired === "object" && desired !== null && "exports" in desired
              ? ({ ...desired, exports: stripEffects(desired.exports) } as typeof desired)
              : desired;
          if (!isResolved(news)) return;
          yield* checkWebFunctionProps(id, news);
          // Creating, or adopted without prior props: reconcile converges.
          if (!output || !olds) return undefined;
          // Generated names are engine-owned; only an explicit functionName
          // change replaces.
          if ((news.functionName ?? output.functionName) !== output.functionName) {
            return { action: "replace" };
          }
          if ((yield* bundle(id, news)).identityHash !== output.code.hash) {
            return { action: "update" };
          }
          if (!havePropsChanged(olds, news)) {
            if (!isResolved(newBindings) || !deepEqual(oldBindings, newBindings)) {
              return undefined;
            }
            return { action: "noop" };
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const functionName =
            output?.functionName ?? (yield* createNames(id, olds?.functionName)).functionName;
          const fn = yield* getFunction(functionName);
          const names = yield* createNames(id, olds?.functionName);
          const endpointName = output?.endpointName ?? olds?.endpointName ?? DEFAULT_ENDPOINT_NAME;
          const { accountId, region } = yield* AWSEnvironment.current;
          const roleName = output?.roleName ?? names.roleName;
          if (fn === undefined) {
            // A create that failed after the execution role was made (e.g.
            // the function create was rejected) leaves only the role. Report
            // it so the engine can re-drive the create or delete the role on
            // destroy instead of orphaning it.
            const role = yield* iam
              .getRole({ RoleName: roleName })
              .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.undefined));
            if (output !== undefined || role === undefined) return undefined;
            const attrs = {
              functionName,
              functionArn: `arn:aws:lambda:${region}:${accountId}:web-function/${functionName}`,
              endpointName,
              endpointArn: `arn:aws:lambda:${region}:${accountId}:web-function/${functionName}/endpoint/${endpointName}`,
              domainName: "",
              url: "",
              authType: olds?.authType ?? "IamAuth",
              endpointType: endpointTypeOf(olds?.regions),
              revisionId: "",
              revisionWeights: [],
              roleName,
              roleArn: role.Role.Arn,
              code: { hash: "" },
            } satisfies WebFunction["Attributes"];
            return (yield* hasAlchemyTags(id, role.Role.Tags)) ? attrs : Unowned(attrs);
          }
          // A missing built-in endpoint reports no address, revision or
          // traffic, so drift sees it is gone instead of the last persisted
          // values.
          const endpoint = yield* getEndpoint(functionName, endpointName);
          const extras = yield* observeFunctionExtras({
            functionArn: fn.functionArn,
            roleName,
            policyName: names.policyName,
          });
          const attrs = {
            ...output,
            functionName: fn.functionName,
            functionArn: fn.functionArn,
            endpointName,
            endpointArn: endpoint?.endpointArn ?? `${fn.functionArn}/endpoint/${endpointName}`,
            domainName: endpoint?.domainName ?? "",
            url: endpoint ? `https://${endpoint.domainName}` : "",
            authType: (endpoint?.authType ??
              output?.authType ??
              olds?.authType ??
              "IamAuth") as WebFunctionAuthType,
            endpointType: (endpoint?.endpointType ??
              output?.endpointType ??
              endpointTypeOf(olds?.regions)) as WebFunctionEndpointType,
            revisionId: endpoint ? latestRevisionId(endpoint, output?.revisionId) : "",
            revisionWeights: endpoint ? servedRevisions(endpoint) : [],
            roleName,
            roleArn: output?.roleArn ?? `arn:aws:iam::${accountId}:role/${roleName}`,
            code: output?.code ?? { hash: "" },
            ...(endpoint
              ? endpointLimits(endpoint)
              : { rateLimit: undefined, maxEnvironments: undefined }),
            ...extras,
          } satisfies WebFunction["Attributes"];
          return (yield* hasAlchemyTags(id, extras.tags)) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, bindings, session }) {
          // Values that were Outputs at plan are resolved now.
          yield* checkWebFunctionProps(id, news);
          const names = yield* createNames(id, news.functionName);
          // Prefer deployed identifiers over regenerated ones.
          const functionName = output?.functionName ?? names.functionName;
          const roleName = output?.roleName ?? names.roleName;

          // Execution role + binding grants.
          const roleArn = yield* ensureRole(id, roleName);
          const { env: bindingEnv, vpcRequests } = yield* syncBindings({
            roleName,
            policyName: names.policyName,
            bindings,
          });
          const vpc = mergeVpc(news.vpc, vpcRequests);
          yield* requireHomeRegion(id, vpc, news.regions);
          const egressNetworkConnectorArn = vpc
            ? yield* syncEgress({ id, vpc, session })
            : undefined;
          yield* syncLogGroups({ id, functionName, roleName });

          // Code: bundle, then upload to the versioned assets bucket Lambda
          // reads revisions from.
          const { identityHash, buildArchive } = yield* bundle(id, news);
          const { archive, archiveHash } = yield* buildArchive;
          const bucket = yield* assets.bucketName;
          yield* ensureLambdaWebCodeAccess(bucket);
          const key = yield* assets.uploadAsset(`web/${archiveHash}`, archive);

          const sourcemap = news.build?.output?.sourcemap ?? true;
          const enableSourceMaps =
            news.bundle !== false &&
            (sourcemap === "inline" ||
              ((news.uploadSourceMap ?? true) && (sourcemap === true || sourcemap === "hidden")));
          const userEnv = Object.fromEntries(
            Object.entries({ ...bindingEnv, ...news.env }).map(([k, v]) => [
              k,
              typeof v === "string" ? v : JSON.stringify(v),
            ]),
          );
          const nodeOptions = [
            userEnv.NODE_OPTIONS,
            enableSourceMaps ? "--enable-source-maps" : undefined,
          ]
            .filter((v): v is string => !!v)
            .join(" ");
          const desiredRevision: LambdaWeb.RevisionConfig = {
            description: news.description,
            buildConfig: {
              codeConfig: { s3Object: { bucket, key } },
              runtimeConfig: { runtime: news.runtime ?? "nodejs24.x" },
            },
            serviceConfig: {
              executionRoleArn: roleArn,
              timeoutSeconds: toTimeoutSeconds(news.timeout),
              maxConcurrencyPerEnvironment:
                news.maxConcurrencyPerEnvironment ?? DEFAULT_MAX_CONCURRENCY,
              ...(egressNetworkConnectorArn ? { egressNetworkConnectorArn } : {}),
              environmentVariables: {
                ...userEnv,
                ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
                ...alchemyEnv,
                AWS_LAMBDA_NODEJS_ENTRYPOINT:
                  news.bundle === false ? mainBasename(news.main) : ENTRY_FILE,
              },
            },
          };

          const endpoint: WebFunctionEndpointSpec = {
            endpointName: news.endpointName ?? DEFAULT_ENDPOINT_NAME,
            authType: news.authType,
            regions: news.regions,
            maxEnvironments: news.maxEnvironments,
            rateLimit: news.rateLimit,
            canary: news.canary,
          };

          // Observe → ensure the function. `CreateWebFunction` creates the
          // first revision and the endpoint together; both are re-observed
          // and synced below like any existing function.
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          let created: LambdaWeb.CreateWebFunctionResponse | undefined;
          if ((yield* getFunction(functionName)) === undefined) {
            created = yield* retryRolePropagation(
              LambdaWeb.createWebFunction({
                functionName,
                revisionConfig: desiredRevision,
                endpointConfig: createEndpointConfig(endpoint),
                tags: desiredTags,
              }),
              session,
              functionName,
            ).pipe(
              // Lost a create race: the function exists, converge on it.
              Effect.catchTag("ConflictException", () => Effect.undefined),
            );
          }
          const fn = yield* waitForFunctionActive(functionName, session);

          // Sync the revision: reuse the one the built-in endpoint, the last
          // deploy, or the create points at when it already matches the
          // desired config (the endpoint is missing after a rename).
          const observedEndpoint = yield* getEndpoint(functionName, endpoint.endpointName);
          const candidateIds = [
            ...(observedEndpoint?.revisionWeights
              .filter((w) => w.weight > 0)
              .map((w) => w.revisionId) ?? []),
            ...(output?.revisionId ? [output.revisionId] : []),
            ...(created?.revision ? [created.revision.revisionId] : []),
          ];
          let revisionId: string | undefined;
          for (const candidate of candidateIds) {
            const observed = yield* getRevision(functionName, candidate);
            if (observed !== undefined && revisionMatches(observed, desiredRevision)) {
              revisionId = candidate;
              break;
            }
          }
          if (revisionId === undefined) {
            const revision = yield* retryRolePropagation(
              LambdaWeb.createWebFunctionRevision({
                functionName,
                description: desiredRevision.description,
                buildConfig: desiredRevision.buildConfig,
                serviceConfig: desiredRevision.serviceConfig,
              }),
              session,
              functionName,
            );
            revisionId = revision.revisionId;
          }
          yield* waitForRevisionActive(functionName, revisionId, session);

          // Sync the built-in endpoint onto the revision. A renamed endpoint is
          // a new endpoint: create it, then remove the previous one.
          const settled = yield* syncEndpoint({
            functionName,
            spec: endpoint,
            revisionId,
            published: output?.revisionId,
            session,
          });
          // Moving off a revision whose egress connector the new one no
          // longer uses (e.g. `vpc` removed) may leave it unused.
          const stillServed = new Set(servedRevisions(settled).map((w) => w.revisionId));
          for (const { revisionId: previous } of observedEndpoint
            ? servedRevisions(observedEndpoint)
            : []) {
            if (stillServed.has(previous)) continue;
            const previousConnector = yield* connectorOfRevision(functionName, previous);
            if (
              previousConnector !== undefined &&
              !sameConnector(previousConnector, egressNetworkConnectorArn)
            ) {
              yield* releaseEgressConnector({
                functionName,
                connectorArn: previousConnector,
                session,
              });
            }
          }
          const previousEndpointName = output?.endpointName;
          if (
            previousEndpointName !== undefined &&
            previousEndpointName !== endpoint.endpointName
          ) {
            yield* deleteEndpoint(functionName, previousEndpointName);
          }

          // Sync tags against the observed cloud tags.
          const observedTags = yield* LambdaWeb.listTags({ resource: fn.functionArn }).pipe(
            Effect.map((r) => r.tags ?? {}),
          );
          const { removed, upsert } = diffTags(
            Object.fromEntries(
              Object.entries(observedTags).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
            desiredTags,
          );
          if (upsert.length > 0) {
            yield* LambdaWeb.tagResource({
              resource: fn.functionArn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* LambdaWeb.untagResource({ resource: fn.functionArn, tagKeys: removed });
          }

          yield* session.note(`https://${settled.domainName}`);
          const extras = yield* observeFunctionExtras({
            functionArn: fn.functionArn,
            roleName,
            policyName: names.policyName,
          });
          return {
            ...toAttributes(fn, settled, { roleName, roleArn }, { hash: identityHash }, revisionId),
            ...extras,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ id, output, session }) {
          // The role may already be gone — every step is idempotent. Grants
          // go first; the log-group guard stays until the function is gone.
          yield* iam.listRolePolicies({ RoleName: output.roleName }).pipe(
            Effect.flatMap((policies) =>
              Effect.forEach(
                (policies.PolicyNames ?? []).filter((name) => name !== LOG_GROUP_GUARD_POLICY),
                (policyName) =>
                  iam
                    .deleteRolePolicy({ RoleName: output.roleName, PolicyName: policyName })
                    .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void)),
              ),
            ),
            Effect.catchTag("NoSuchEntityException", () => Effect.void),
          );
          yield* iam.listAttachedRolePolicies({ RoleName: output.roleName }).pipe(
            Effect.flatMap((policies) =>
              Effect.forEach(policies.AttachedPolicies ?? [], (policy) =>
                iam
                  .detachRolePolicy({ RoleName: output.roleName, PolicyArn: policy.PolicyArn! })
                  .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void)),
              ),
            ),
            Effect.catchTag("NoSuchEntityException", () => Effect.void),
          );

          yield* LambdaWeb.deleteWebFunction({ functionName: output.functionName }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            Effect.retry({
              while: (e) => e._tag === "ConflictException",
              schedule: Schedule.spaced("2 seconds"),
              times: 15,
            }),
          );
          yield* waitForFunctionGone(output.functionName);
          // A connector still referenced at delete time (e.g. by an endpoint
          // that never moved off it) goes with the function.
          yield* deleteEgress(id, session);

          yield* iam
            .deleteRolePolicy({ RoleName: output.roleName, PolicyName: LOG_GROUP_GUARD_POLICY })
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

          // The role could never create these groups (see `syncLogGroups`),
          // so one delete is final.
          yield* Effect.forEach(logGroupNames(output.functionName), (logGroupName) =>
            logs
              .deleteLogGroup({ logGroupName })
              .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
          );
        }),
        tail: ({ output }) => {
          const session = Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const response = yield* logs.startLiveTail({
              logGroupIdentifiers: [
                `arn:aws:logs:${region}:${accountId}:log-group:${logGroupNames(output.functionName)[0]}`,
              ],
            });
            if (!response.responseStream) {
              return Stream.empty as Stream.Stream<LogLine>;
            }
            return response.responseStream.pipe(
              Stream.flatMap((event) =>
                "sessionUpdate" in event && event.sessionUpdate
                  ? Stream.fromIterable(
                      (event.sessionUpdate.sessionResults ?? []).flatMap((result): LogLine[] =>
                        result.message
                          ? [
                              {
                                timestamp: new Date(result.timestamp ?? Date.now()),
                                message: result.message.trimEnd(),
                              },
                            ]
                          : [],
                      ),
                    )
                  : Stream.empty,
              ),
            );
          });
          return Stream.unwrap(session).pipe(Stream.retry(Schedule.spaced("1 second")));
        },
        logs: ({ output, options }: { output: WebFunction["Attributes"]; options: LogsInput }) =>
          logs
            .filterLogEvents({
              logGroupName: logGroupNames(output.functionName)[0],
              startTime: options.since?.getTime(),
              limit: options.limit ?? 100,
            })
            .pipe(
              Effect.map((response) =>
                (response.events ?? []).flatMap((event): LogLine[] =>
                  event.message
                    ? [
                        {
                          timestamp: new Date(event.timestamp ?? Date.now()),
                          message: event.message.trimEnd(),
                        },
                      ]
                    : [],
                ),
              ),
              Effect.catchTag("ResourceNotFoundException", () => Effect.succeed([] as LogLine[])),
            ),
      };
    }),
  );
