import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import {
  hostAwsAccess,
  regionFromArn,
  withRuntimeCredentials,
} from "./BindingHttp.ts";
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

        // Accessors (registered on the host at deploy, resolved at runtime).
        const imageArn = yield* image.imageArn;
        // Region is derived from the resolved image ARN — via `Effect.map` of
        // the accessor, NOT a second Output binding (whose env key would embed
        // the mapper's source text and is brittle).
        const region = Effect.map(imageArn, regionFromArn);

        const access = yield* hostAwsAccess(host, () => ({
          label: `Allow(${host?.LogicalId}, AWS.Lambda.${options.name}(${image.LogicalId}))`,
          policyStatements: imagePolicyStatements(image, options),
        }));

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
        const access = yield* hostAwsAccess(host, () => ({
          label: `Allow(${host?.LogicalId}, AWS.Lambda.${options.name}())`,
          policyStatements: [
            { Effect: "Allow", Action: options.actions, Resource: ["*"] },
          ],
        }));

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
