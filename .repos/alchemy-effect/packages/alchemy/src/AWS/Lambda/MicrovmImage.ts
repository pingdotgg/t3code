import type { Credentials } from "@distilled.cloud/aws/Credentials";
import type { Region } from "@distilled.cloud/aws/Region";
import type * as microvms from "@distilled.cloud/aws/lambda-microvms";

import * as Effect from "effect/Effect";
import { Platform } from "../../Platform.ts";
import type { Main } from "../../Platform.ts";
import type { Resource } from "../../Resource.ts";
import type * as Server from "../../Server/index.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Role } from "../IAM/Role.ts";
import type { Providers } from "../Providers.ts";
import {
  makeMicrovmRuntimeContext,
  MicrovmImageTypeId,
} from "./MicrovmRuntimeContext.ts";

/**
 * The IAM permissions a build role needs: read the code artifact from the
 * Assets bucket(s) and write build logs to CloudWatch. Used to auto-grant a
 * {@link Role} passed as `buildRole`.
 */
const buildRolePolicyStatements: PolicyStatement[] = [
  {
    Effect: "Allow",
    Action: ["s3:GetObject"],
    Resource: ["arn:aws:s3:::alchemy-assets-*-an/*"],
  },
  {
    Effect: "Allow",
    Action: [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ],
    Resource: ["arn:aws:logs:*:*:log-group:/aws/lambda/microvms/*"],
  },
];

export { MicrovmImageTypeId } from "./MicrovmRuntimeContext.ts";

export interface MicrovmImageProps {
  /**
   * The name of the MicroVM image. Must be 1-64 characters of letters,
   * numbers, hyphens, or underscores. If omitted, a unique name is generated.
   * Changing the name replaces the image.
   */
  name?: string;

  /**
   * **Effectful mode.** Entrypoint file for an Effect-native HTTP server,
   * typically `import.meta.filename`. Alchemy bundles it (with its bindings),
   * generates a Dockerfile, zips the result, and uploads it as the
   * `codeArtifact`.
   */
  main?: string;

  /**
   * **External mode.** A build-context directory containing your Dockerfile and
   * the files it copies. Alchemy zips and uploads it; AWS runs your Dockerfile.
   * @default "./"
   */
  context?: string;

  /**
   * The Dockerfile. In effectful mode this is an inline base string (defaults
   * to `FROM public.ecr.aws/lambda/microvms:al2023-minimal`). In external mode
   * it is a path relative to {@link context} (defaults to `<context>/Dockerfile`).
   */
  dockerfile?: string;

  /**
   * The port the in-VM HTTP server listens on (effectful mode).
   * @default 8080
   */
  port?: number;

  /**
   * The JS runtime to bundle for (effectful mode).
   * @default "node"
   */
  runtime?: "bun" | "node";

  /**
   * Extra module ids to leave external when bundling (effectful mode).
   */
  external?: string[];

  /**
   * The base MicroVM image to build on top of — either its ARN or another
   * {@link MicrovmImage} instance. If omitted, the latest AWS-managed `al2023`
   * base is used (discover bases with {@link microvms.listManagedMicrovmImages}).
   */
  baseImage?: string | MicrovmImage;

  /**
   * The specific version of the base MicroVM image.
   */
  baseImageVersion?: string;

  /**
   * The IAM role Lambda assumes to build the image (read the code artifact,
   * write build logs) — either its ARN or an {@link Role} instance. When you
   * pass a `Role`, the required S3 (Assets bucket) and CloudWatch-logs
   * permissions are granted to it automatically via a binding, so you don't
   * have to write the inline policy yourself. Required for all builds.
   */
  buildRole?: string | Role;

  /**
   * **Prebuilt mode.** A code artifact (S3 zip path or ECR image URI) to use
   * as-is, instead of bundling (`main`) or building a context (`context`).
   */
  codeArtifact?: microvms.CodeArtifact;

  /**
   * A description of the image version.
   */
  description?: string;

  /**
   * Logging configuration for the MicroVM runtime/build. Specify exactly one of
   * `cloudWatch` or `disabled`.
   */
  logging?: microvms.Logging;

  /**
   * The names/ARNs of egress network connectors available to the MicroVM at
   * runtime (see {@link NetworkConnector}).
   */
  egressNetworkConnectors?: string[];

  /**
   * The CPU configurations the image supports.
   */
  cpuConfigurations?: microvms.CpuConfiguration[];

  /**
   * The resource requirements (e.g. minimum memory) for the MicroVM.
   */
  resources?: microvms.Resources[];

  /**
   * Additional OS capabilities granted to the MicroVM runtime.
   */
  additionalOsCapabilities?: microvms.Capability[];

  /**
   * Lifecycle hook configuration for the MicroVM and its image.
   */
  hooks?: microvms.Hooks;

  /**
   * Environment variables set in the MicroVM runtime environment. Capability
   * bindings (e.g. S3/DynamoDB clients) also contribute entries here during
   * plan; all of them are written to the image's environment.
   */
  env?: Record<string, any>;

  /**
   * Tags to apply to the image.
   */
  tags?: Record<string, string>;

  /**
   * @internal Platform-managed: the bundled runtime entrypoint.
   */
  exports?: string[] | Record<string, any>;

  /**
   * @internal Platform-managed: signals a non-Effect-native (external) image.
   */
  isExternal?: boolean;
}

export interface MicrovmImage extends Resource<
  "AWS.Lambda.MicrovmImage",
  MicrovmImageProps,
  {
    /** The ARN of the MicroVM image. */
    imageArn: string;
    /** The name of the MicroVM image. */
    name: string;
    /** The current state of the image (e.g. `CREATED`, `CREATING`). */
    state: microvms.MicrovmImageState;
    /** The image version produced by the most recent build. */
    imageVersion?: string;
    /** The latest version that built successfully. */
    latestActiveImageVersion?: string;
    /** The latest version that failed to build, if any. */
    latestFailedImageVersion?: string;
    /** When the image was created (ISO 8601). */
    createdAt?: string;
    /** When the image was last updated (ISO 8601). */
    updatedAt?: string;
    /** The resolved code artifact and its build identity hash. */
    codeArtifact?: { uri?: string; hash?: string };
  },
  {
    env?: Record<string, any>;
    policyStatements?: PolicyStatement[];
  },
  Providers
> {}

export type MicrovmImageServices = Credentials | Region;
export type MicrovmImageShape = Main<MicrovmImageServices>;

/**
 * A Lambda **MicroVM image** — a Firecracker snapshot that boots a fully
 * initialized application in milliseconds. The model is *image-then-launch*:
 * you create an image once (this resource), then launch isolated, stateful
 * MicroVM instances from it at runtime (one per end-user/session) with the
 * {@link RunMicrovm} binding from a Lambda Function.
 *
 * ### How the build works
 *
 * The build runs **server-side on AWS** — there is no local Docker. You supply
 * a *code artifact* (a zip of a Dockerfile + your code) and a *base image*
 * (`baseImage`); AWS runs your Dockerfile on top of the base, initializes
 * the app, and takes a Firecracker snapshot. The build is asynchronous: the
 * provider uploads the artifact, calls `CreateMicrovmImage`/`UpdateMicrovmImage`,
 * and polls until the image reaches `CREATED`/`UPDATED` (or surfaces the build
 * failure). Build logs stream to CloudWatch at `/aws/lambda/microvms/<name>`.
 *
 * Alchemy produces the code artifact for you in three ways, selected by which
 * prop you set (`main` → `context` → `codeArtifact.uri`):
 *
 * - **Effectful** (`main`): write the in-VM HTTP server in TypeScript as an
 *   Effect. Alchemy bundles it (with its capability bindings), generates a
 *   Dockerfile on the MicroVM base, zips both, and uploads to the Assets bucket.
 * - **External** (`context`/`dockerfile`): bring your own Dockerfile + build
 *   context (any language). Alchemy zips the directory and uploads it.
 * - **Prebuilt** (`codeArtifact.uri`): point at an existing S3 zip or ECR image
 *   URI; nothing is built or uploaded.
 *
 * Re-deploys only trigger a new build when the artifact's content hash or a
 * build-affecting prop changes; otherwise the image is left untouched.
 *
 * ### Prerequisites
 *
 * - A **build role** (`buildRole`) Lambda assumes to read the code artifact and
 *   write build logs. Pass a {@link Role} instance and the required permissions
 *   are granted automatically — see the example below.
 * - A **bootstrapped Assets bucket** (`alchemy aws bootstrap`) for effectful /
 *   external modes, which upload the artifact to S3.
 * - The account must be **onboarded to the Lambda MicroVM preview**.
 *
 * @resource
 *
 * @section Creating the Build Role
 * Pass a bare {@link Role} as `buildRole` and the MicroVM image grants
 * everything it needs via a binding: the trust policy (so Lambda can assume it)
 * plus the S3 (Assets bucket) and CloudWatch-logs permissions (folded into an
 * `alchemy-bindings` inline policy). You don't write any policy yourself.
 * @example Bare build role
 * ```typescript
 * const buildRole = yield* AWS.IAM.Role("MicrovmBuildRole", {});
 *
 * // Pass the role instance; trust + permissions are attached for you.
 * const image = yield* AWS.Lambda.MicrovmImage("Sandbox", {
 *   main: import.meta.filename,
 *   buildRole,
 * });
 * ```
 *
 * @section Effectful MicroVMs
 * Write the in-VM server in TypeScript. Alchemy bundles `main` and bakes it into
 * the image; the server listens on `port` (default 8080), which becomes the
 * MicroVM `endpoint`.
 * @example In-VM HTTP server (single file)
 * ```typescript
 * export default class Sandbox extends AWS.Lambda.MicrovmImage<Sandbox>()(
 *   "Sandbox",
 *   { main: import.meta.filename, buildRole },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         return HttpServerResponse.text(`hello from ${request.url}`);
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @example With capability bindings and env vars
 * ```typescript
 * export default class Sandbox extends AWS.Lambda.MicrovmImage<Sandbox>()(
 *   "Sandbox",
 *   {
 *     main: import.meta.filename,
 *     buildRole,
 *     runtime: "bun",
 *     env: { LOG_LEVEL: "info" },
 *   },
 *   Effect.gen(function* () {
 *     // bindings are bundled into the image and resolved at runtime
 *     const getObject = yield* AWS.S3.GetObject(bucket);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const obj = yield* getObject({ key: "data.json" });
 *         return HttpServerResponse.json(yield* obj.json);
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.S3.GetObjectHttp)),
 * ) {}
 * ```
 *
 * @example Class + `.make()` (two files, for a Lambda orchestrator)
 * When a Lambda Function imports the image to bind its instance operations, keep
 * the class (a typed handle) and the `.make()` runtime in separate files so the
 * orchestrator's bundle doesn't pull in the VM's runtime deps.
 * ```typescript
 * // sandbox.ts — imported by the orchestrator
 * export class Sandbox extends AWS.Lambda.MicrovmImage<Sandbox>()("Sandbox") {}
 *
 * // sandbox.live.ts — provided on the Stack; bundled into the image.
 * // Must be the `default` export: the bundler resolves the image entrypoint
 * // from the code artifact's default export.
 * export default Sandbox.make(
 *   { main: import.meta.filename, buildRole },
 *   Effect.gen(function* () {
 *     return { fetch: Effect.gen(function* () {
 *       return HttpServerResponse.text("ok");
 *     }) };
 *   }),
 * );
 * ```
 *
 * @section Tagged RPC
 * Beyond (or instead of) a raw `fetch` handler, an image can expose a typed
 * **RPC `Shape`** as the second type parameter. The in-VM runtime serves those
 * methods over an `/__rpc__/*` protocol and falls through to `fetch` for every
 * other request, so an image can offer BOTH a typed RPC surface and ordinary
 * HTTP routes. A caller gets a fully-typed client with {@link connectMicrovm}:
 * value methods `yield*` as `Effect`s, streaming methods pipe as `Stream`s.
 * @example Define a tagged-RPC image (RPC + fetch)
 * ```typescript
 * // sandbox.ts — the typed handle imported by the orchestrator Lambda
 * export class Sandbox extends AWS.Lambda.MicrovmImage<
 *   Sandbox,
 *   { hello: (message: string) => Effect.Effect<string> }
 * >()("Sandbox") {}
 *
 * // sandbox.live.ts — provided on the Stack; bundled into the image (default export)
 * export default Sandbox.make(
 *   { main: import.meta.filename, buildRole },
 *   Effect.gen(function* () {
 *     return {
 *       // RPC method — reached with `connectMicrovm` below
 *       hello: (message: string) => Effect.succeed(`hello, ${message}!`),
 *       // raw HTTP route — reached with a plain HTTPS request to the endpoint
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const url = new URL(request.url, "http://microvm");
 *         return HttpServerResponse.json({ path: url.pathname });
 *       }),
 *     };
 *   }),
 * );
 * ```
 *
 * @example Call the RPC method from a Lambda
 * `connectMicrovm` builds the typed stub over an `HttpClient` (provide
 * `FetchHttpClient.layer` for the request scope), pointing at the running
 * MicroVM's `endpoint` and authenticating with the `authToken` headers.
 * ```typescript
 * const vm = yield* runMicrovm({});
 * // ...wait until `vm.state` is RUNNING (poll `getMicrovm`)...
 * const { authToken } = yield* createAuthToken({
 *   microvmIdentifier: vm.microvmId,
 *   expirationInMinutes: 5,
 *   allowedPorts: [{ port: 8080 }], // the in-VM server's port
 * });
 *
 * const sandbox = yield* AWS.Lambda.connectMicrovm(Sandbox, {
 *   endpoint: vm.endpoint,
 *   authToken,
 * });
 * const reply = yield* sandbox.hello("world"); // "hello, world!"
 * ```
 *
 * @example Call the same MicroVM's `fetch` route directly
 * For the raw HTTP path, send the auth token as request headers via
 * {@link microvmAuthHeaders}.
 * ```typescript
 * const client = yield* HttpClient.HttpClient;
 * const res = yield* client.get(`https://${vm.endpoint}/echo?message=hi`, {
 *   headers: AWS.Lambda.microvmAuthHeaders(authToken),
 * });
 * const body = yield* res.json;
 * ```
 *
 * @section External Images (your own Dockerfile)
 * Bring a build context directory containing a Dockerfile (any language).
 * Alchemy zips and uploads it; AWS runs your Dockerfile. Your Dockerfile should
 * build on a MicroVM-compatible base (e.g.
 * `FROM public.ecr.aws/lambda/microvms:al2023-minimal`).
 * @example Flask app from a Dockerfile
 * ```typescript
 * const image = yield* AWS.Lambda.MicrovmImage("Flask", {
 *   context: `${import.meta.dirname}/app`, // dir with Dockerfile + app.py
 *   buildRole,
 * });
 * ```
 * @example Custom Dockerfile path within the context
 * ```typescript
 * const image = yield* AWS.Lambda.MicrovmImage("Worker", {
 *   context: `${import.meta.dirname}/app`,
 *   dockerfile: "docker/worker.Dockerfile", // relative to `context`
 *   buildRole,
 * });
 * ```
 *
 * @section Prebuilt Artifacts
 * Skip the build entirely and point at an artifact you already produced.
 * @example From an existing S3 zip
 * ```typescript
 * const image = yield* AWS.Lambda.MicrovmImage("Prebuilt", {
 *   codeArtifact: { uri: "s3://my-bucket/app.zip" }, // or an ECR image URI
 *   buildRole,
 * });
 * ```
 *
 * @section Sizing and Base Image
 * `baseImage` defaults to the latest AWS-managed `al2023` base (discovered
 * via `listManagedMicrovmImages`). Override it, and tune CPU/memory, explicitly.
 * @example Pin the base image and resources
 * ```typescript
 * const image = yield* AWS.Lambda.MicrovmImage("Sized", {
 *   main: import.meta.filename,
 *   buildRole,
 *   baseImage: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1",
 *   cpuConfigurations: [{ architecture: "ARM_64" }],
 *   resources: [{ minimumMemoryInMiB: 2048 }],
 * });
 * ```
 *
 * @section Logging
 * @example Stream runtime + build logs to a custom CloudWatch group
 * ```typescript
 * const image = yield* AWS.Lambda.MicrovmImage("Logged", {
 *   main: import.meta.filename,
 *   buildRole,
 *   logging: { cloudWatch: { logGroup: "/aws/microvm/my-app" } },
 *   // or disable: logging: { disabled: {} }
 * });
 * ```
 *
 * @section VPC Egress
 * Give the MicroVM a managed egress path into your VPC with a
 * {@link NetworkConnector} (reference it by ARN).
 * @example Image-level egress connector
 * ```typescript
 * const egress = yield* AWS.Lambda.NetworkConnector("Egress", {
 *   subnetIds: [subnet.subnetId],
 *   securityGroupIds: [sg.groupId],
 *   operatorRole: operatorRole.roleArn,
 * });
 *
 * const image = yield* AWS.Lambda.MicrovmImage("Connected", {
 *   main: import.meta.filename,
 *   buildRole,
 *   egressNetworkConnectors: [egress.networkConnectorArn],
 * });
 * ```
 *
 * @section Launching MicroVMs
 * The image is just the template. Launch and drive instances from a Lambda
 * Function using the per-operation bindings ({@link RunMicrovm},
 * {@link GetMicrovm}, {@link CreateAuthToken}, {@link TerminateMicrovm}, …).
 * Each binding's IAM policy is scoped to this image automatically.
 * @example Run a MicroVM, call its RPC, and tear it down
 * Always terminate the MicroVM you launched — wrap the work in
 * `Effect.ensuring` so a failure (or a client retry) never leaks a running
 * MicroVM against your account's memory quota. Give the Function a generous
 * `timeout` since it waits for the MicroVM to reach RUNNING in-line.
 * ```typescript
 * export default class Api extends AWS.Lambda.Function<Api>()(
 *   "Api",
 *   { main: import.meta.filename, url: true, timeout: Duration.seconds(120) },
 *   Effect.gen(function* () {
 *     const runMicrovm = yield* AWS.Lambda.RunMicrovm(Sandbox);
 *     const getMicrovm = yield* AWS.Lambda.GetMicrovm(Sandbox);
 *     const createAuthToken = yield* AWS.Lambda.CreateAuthToken(Sandbox);
 *     const terminateMicrovm = yield* AWS.Lambda.TerminateMicrovm(Sandbox);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const vm = yield* runMicrovm({
 *           idlePolicy: {
 *             maxIdleDurationSeconds: 900,
 *             suspendedDurationSeconds: 300,
 *             autoResumeEnabled: true,
 *           },
 *         });
 *         return yield* Effect.gen(function* () {
 *           // wait until the MicroVM is RUNNING before connecting
 *           yield* getMicrovm({ microvmIdentifier: vm.microvmId }).pipe(
 *             Effect.flatMap((m) =>
 *               m.state === "RUNNING"
 *                 ? Effect.void
 *                 : Effect.fail(new Error(`microvm ${m.state}`)),
 *             ),
 *             Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
 *           );
 *           const { authToken } = yield* createAuthToken({
 *             microvmIdentifier: vm.microvmId,
 *             expirationInMinutes: 5,
 *             allowedPorts: [{ port: 8080 }],
 *           });
 *           const sandbox = yield* AWS.Lambda.connectMicrovm(Sandbox, {
 *             endpoint: vm.endpoint,
 *             authToken,
 *           });
 *           const reply = yield* sandbox.hello("world");
 *           return yield* HttpServerResponse.json({ reply });
 *         }).pipe(
 *           // terminate on success OR failure — never leak a running MicroVM
 *           Effect.ensuring(
 *             terminateMicrovm({ microvmIdentifier: vm.microvmId }).pipe(
 *               Effect.ignore,
 *             ),
 *           ),
 *           // the in-VM endpoint calls need an HttpClient for this scope
 *           Effect.provide(FetchHttpClient.layer),
 *         );
 *       }),
 *     };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(
 *         AWS.Lambda.RunMicrovmHttp,
 *         AWS.Lambda.GetMicrovmHttp,
 *         AWS.Lambda.CreateAuthTokenHttp,
 *         AWS.Lambda.TerminateMicrovmHttp,
 *       ),
 *     ),
 *   ),
 * ) {}
 * ```
 */
export const MicrovmImage: Platform<
  MicrovmImage,
  MicrovmImageServices,
  MicrovmImageShape,
  Server.ProcessContext
> = Platform(MicrovmImageTypeId, {
  createRuntimeContext: makeMicrovmRuntimeContext,
  // When `buildRole` is a Role instance, grant it the build permissions via a
  // binding so the user doesn't have to author the inline policy.
  onCreate: (_resource, props: MicrovmImageProps) =>
    props.buildRole && typeof props.buildRole !== "string"
      ? props.buildRole
          .bind`Allow(${_resource}, AWS.Lambda.MicrovmImage.build)`({
          // Grant the build permissions...
          policyStatements: buildRolePolicyStatements,
          // ...and the trust statement, so a build role passed as a bare
          // `Role` (no `assumeRolePolicyDocument`) can be assumed by Lambda.
          assumeRolePolicyStatements: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: ["sts:AssumeRole"],
            },
          ],
        })
      : Effect.void,
});
