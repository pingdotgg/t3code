import type * as LambdaWeb from "@distilled.cloud/aws/lambda-web";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { connectorOfRevision, releaseEgressConnector, sameConnector } from "./WebFunctionEgress.ts";
import {
  deleteEndpoint,
  endpointIdentityChanged,
  endpointLimits,
  getEndpoint,
  latestRevisionId,
  servedRevisions,
  syncEndpoint,
  toEndpointName,
  validateWebFunctionSettings,
  type WebFunctionAuthType,
  type WebFunctionCanary,
  type WebFunctionEndpointType,
  type WebFunctionRevisionWeight,
} from "./WebFunctionEndpointSync.ts";

export const WebFunctionEndpointTypeId = "AWS.Lambda.WebFunctionEndpoint" as const;
export type WebFunctionEndpointTypeId = typeof WebFunctionEndpointTypeId;

/** The parts of a Web Function an endpoint routes to. */
export interface WebFunctionRef {
  functionName: string;
  revisionId: string;
}

/**
 * A resource or its declaration (e.g. a `WebFunction` class), which is
 * yielded for you.
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export interface WebFunctionEndpointProps {
  /**
   * The Web Function this endpoint serves: the `AWS.Lambda.WebFunction`
   * resource, or its class declaration. The endpoint routes traffic to the
   * function's latest revision and follows it on every deploy. Changing
   * the function recreates the endpoint, which gets a new URL.
   */
  function: Ref<WebFunctionRef>;
  /**
   * Name of the endpoint. Your server receives it in the
   * `lambda-web-endpoint-name` request header. Letters, digits, `-` and
   * `_`, up to 64 characters. Changing it recreates the endpoint, which gets
   * a new URL.
   * @default the logical ID
   */
  endpointName?: string;
  /**
   * Who may call the endpoint. `"ApplicationManaged"` forwards every request
   * (a public endpoint; authenticate in your application). `"IamAuth"`
   * requires SigV4-signed requests from principals with
   * `lambda:InvokeWebFunctionEndpoint`. Changes apply in place.
   */
  authType: WebFunctionAuthType;
  /**
   * Additional AWS Regions to serve from. When set, the endpoint is
   * `MultiRegion`: one global domain with latency-based routing across the
   * home Region and these Regions. Changing it recreates the endpoint, which
   * gets a new URL.
   */
  regions?: string[];
  /**
   * Maximum number of execution environments this endpoint uses per Region
   * (2–10,000). Endpoints scale independently. Changes apply in place.
   */
  maxEnvironments?: number;
  /**
   * Maximum requests per second this endpoint accepts, enforced per Region.
   * Excess requests receive HTTP 429; `0` disables the endpoint. Changes
   * apply in place.
   */
  rateLimit?: number;
  /**
   * Roll out deploys gradually on this endpoint: the revision a deploy
   * publishes gets `weight` percent of traffic and the revision the
   * endpoint served before keeps the rest. Set it to `100` (or remove
   * `canary`) to promote, or `0` to roll back. Independent of the function's
   * own `canary`.
   */
  canary?: WebFunctionCanary;
  /**
   * Description of the endpoint.
   */
  description?: string;
}

export interface WebFunctionEndpoint extends Resource<
  WebFunctionEndpointTypeId,
  WebFunctionEndpointProps,
  {
    /** Name of the Web Function the endpoint serves. */
    functionName: string;
    /** ARN of the Web Function the endpoint serves. */
    functionArn: string;
    /** Auth type of the endpoint. */
    authType: WebFunctionAuthType;
    /**
     * `HomeRegion`, or `MultiRegion` when `regions` is set: one global
     * domain that routes each request to the nearest Region.
     */
    endpointType: WebFunctionEndpointType;
    /** Name of the endpoint. */
    endpointName: string;
    /** ARN of the endpoint, the resource for `lambda:InvokeWebFunctionEndpoint`. */
    endpointArn: string;
    /** Lambda-allocated domain of the endpoint. */
    domainName: string;
    /** HTTPS URL of the endpoint (`https://<domainName>`). */
    url: string;
    /**
     * The function's latest revision, which the endpoint routes all traffic
     * to, or `canary.weight` percent while a canary runs.
     */
    revisionId: string;
    /**
     * How the endpoint splits traffic: one revision at 100, or the stable
     * revision and the canary while a canary runs.
     */
    revisionWeights: WebFunctionRevisionWeight[];
    /**
     * Requests per second the endpoint allows, as observed. Lets
     * `alchemy drift` detect out-of-band changes.
     */
    rateLimit?: number;
    /**
     * Cap on the endpoint's execution environments, as observed. Lets
     * `alchemy drift` detect out-of-band changes.
     */
    maxEnvironments?: number;
  },
  never,
  Providers
> {}

const WebFunctionEndpointResource = Resource<WebFunctionEndpoint>(WebFunctionEndpointTypeId);

/** Yield a `function` declaration so the endpoint references the resource. */
/** The settings Lambda limits, as numbers (Outputs resolve at deploy). */
const checkEndpointProps = (id: string, props: WebFunctionEndpointProps) =>
  validateWebFunctionSettings(`AWS.Lambda.WebFunctionEndpoint "${id}"`, {
    rateLimit: typeof props.rateLimit === "number" ? props.rateLimit : undefined,
    maxEnvironments: typeof props.maxEnvironments === "number" ? props.maxEnvironments : undefined,
    canary: typeof props.canary?.weight === "number" ? props.canary : undefined,
  });

const resolveEndpointProps = (
  id: string,
  props: WebFunctionEndpointProps | Effect.Effect<WebFunctionEndpointProps, never, Providers>,
): Effect.Effect<WebFunctionEndpointProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const fn = Effect.isEffect(resolved.function) ? yield* resolved.function : resolved.function;
    // Declaration props can't fail: surface the invalid value as a defect,
    // which still stops the plan with its message.
    yield* checkEndpointProps(id, resolved).pipe(
      Effect.catchTag("WebFunctionInvalidConfig", (e) => Effect.die(e)),
    );
    return { ...resolved, function: fn };
  });

/**
 * An additional HTTPS endpoint for an `AWS.Lambda.WebFunction`.
 *
 * Every Web Function has a built-in endpoint, configured on the function.
 * Add a `WebFunctionEndpoint` for each extra way in: its own URL, auth type,
 * environment cap, and rate limit. Endpoints scale independently of each
 * other but serve the same code, so a burst on one can't use up another's
 * environments. Your server tells them apart by the
 * `lambda-web-endpoint-name` request header, which callers can't forge.
 *
 * ### Adding an endpoint
 * **Example:** A public webhook endpoint next to a private one
 * ```typescript
 * const api = yield* AWS.Lambda.WebFunction("Api", {
 *   main: "./src/server.ts",
 *   authType: "IamAuth",
 * });
 *
 * const webhooks = yield* AWS.Lambda.WebFunctionEndpoint("Webhooks", {
 *   function: api,
 *   authType: "ApplicationManaged",
 *   rateLimit: 100,
 *   maxEnvironments: 2,
 * });
 *
 * webhooks.url; // https://<id>.<shard>.lambda-web.<region>.on.aws
 * ```
 *
 * **Example:** With a class-form Web Function
 * Pass the class itself (here `Api`, declared with
 * `class Api extends AWS.Lambda.WebFunction<Api>()(...)`); the endpoint
 * yields it for you.
 * ```typescript
 * const webhooks = yield* AWS.Lambda.WebFunctionEndpoint("Webhooks", {
 *   function: Api,
 *   authType: "ApplicationManaged",
 * });
 * ```
 *
 * ### Canary deploys
 * **Example:** Roll out to the public endpoint more slowly
 * ```typescript
 * // The function's own endpoint takes each deploy at once; this one
 * // sends 5% to the new revision until you raise or remove `canary`.
 * const webhooks = yield* AWS.Lambda.WebFunctionEndpoint("Webhooks", {
 *   function: api,
 *   authType: "ApplicationManaged",
 *   canary: { weight: 5 },
 * });
 * ```
 *
 * ### Routing by endpoint
 * **Example:** Serve only webhook routes on the public endpoint
 * ```typescript
 * // src/server.ts (a Hono app)
 * app.use(async (c, next) => {
 *   const endpoint = c.req.header("lambda-web-endpoint-name");
 *   if (endpoint === "Webhooks" && !c.req.path.startsWith("/webhooks/")) {
 *     return c.notFound();
 *   }
 *   await next();
 * });
 * ```
 *
 * @resource
 */
export const WebFunctionEndpoint: typeof WebFunctionEndpointResource = Object.assign(
  (
    id: string,
    props: WebFunctionEndpointProps | Effect.Effect<WebFunctionEndpointProps, never, Providers>,
  ) => WebFunctionEndpointResource(id, resolveEndpointProps(id, props)),
  WebFunctionEndpointResource,
);

/** A declared `function` resolves to the resource before the provider runs. */
const functionOf = (props: WebFunctionEndpointProps): WebFunctionRef =>
  props.function as WebFunctionRef;

export const WebFunctionEndpointProvider = () =>
  Provider.effect(
    WebFunctionEndpoint,
    Effect.gen(function* () {
      const nameOf = (id: string, props: { endpointName?: string } | undefined) =>
        props?.endpointName ?? toEndpointName(id);

      const toAttributes = (
        functionName: string,
        endpoint: LambdaWeb.GetWebFunctionEndpointResponse,
        revisionId: string,
      ): WebFunctionEndpoint["Attributes"] => ({
        functionName,
        functionArn: endpoint.functionArn,
        authType: endpoint.authType as WebFunctionAuthType,
        endpointType: endpoint.endpointType as WebFunctionEndpointType,
        endpointName: endpoint.endpointName,
        endpointArn: endpoint.endpointArn,
        domainName: endpoint.domainName,
        url: `https://${endpoint.domainName}`,
        revisionId,
        revisionWeights: servedRevisions(endpoint),
        ...endpointLimits(endpoint),
      });

      return {
        stables: ["functionName", "endpointName", "endpointArn"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return;
          yield* validateWebFunctionSettings(`AWS.Lambda.WebFunctionEndpoint "${id}"`, {
            rateLimit: news.rateLimit,
            maxEnvironments: news.maxEnvironments,
            canary: news.canary,
          });
          if (!output || !olds) return undefined;
          // A different function, name, type, or Region set is a different
          // endpoint (and URL). The name is shared with the old endpoint on
          // the same function, so the old one must go first.
          const sameFunction = functionOf(news).functionName === output.functionName;
          const sameName = nameOf(id, news) === output.endpointName;
          if (!sameFunction || !sameName) {
            return { action: "replace" };
          }
          if (endpointIdentityChanged(olds, news)) {
            return { action: "replace", deleteFirst: true };
          }
          if (deepEqual(olds, news)) return { action: "noop" };
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const functionName =
            output?.functionName ?? (olds ? functionOf(olds).functionName : undefined);
          if (functionName === undefined) return undefined;
          const endpointName = output?.endpointName ?? nameOf(id, olds);
          const endpoint = yield* getEndpoint(functionName, endpointName);
          // Endpoints carry their function's tags: ownership follows the
          // function's.
          return endpoint === undefined
            ? undefined
            : toAttributes(functionName, endpoint, latestRevisionId(endpoint, output?.revisionId));
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // Values that were Outputs at plan are resolved now.
          yield* checkEndpointProps(id, news);
          const functionName = functionOf(news).functionName;
          const endpointName = output?.endpointName ?? nameOf(id, news);
          const previous = yield* getEndpoint(functionName, endpointName);
          const revisionId = functionOf(news).revisionId;
          const endpoint = yield* syncEndpoint({
            functionName,
            spec: {
              endpointName,
              authType: news.authType,
              regions: news.regions,
              maxEnvironments: news.maxEnvironments,
              rateLimit: news.rateLimit,
              description: news.description,
              canary: news.canary,
            },
            revisionId,
            published: output?.revisionId,
            session,
          });
          // Moving off a revision whose egress connector the new one no
          // longer uses (e.g. `vpc` removed) may leave it unused.
          const stillServed = new Set(servedRevisions(endpoint).map((w) => w.revisionId));
          for (const { revisionId: previousRevisionId } of previous
            ? servedRevisions(previous)
            : []) {
            if (stillServed.has(previousRevisionId)) continue;
            const previousConnector = yield* connectorOfRevision(functionName, previousRevisionId);
            const currentConnector = yield* connectorOfRevision(functionName, revisionId);
            if (
              previousConnector !== undefined &&
              !sameConnector(previousConnector, currentConnector)
            ) {
              yield* releaseEgressConnector({
                functionName,
                connectorArn: previousConnector,
                session,
              });
            }
          }
          yield* session.note(`https://${endpoint.domainName}`);
          return toAttributes(functionName, endpoint, revisionId);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Deleting the function deletes its endpoints too; a missing
          // function or endpoint is already deleted.
          yield* deleteEndpoint(output.functionName, output.endpointName);
        }),
      };
    }),
  );
