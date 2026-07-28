import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";
import type { Environment } from "./Environment.ts";

/**
 * The deployment notification action points an AppConfig deployment emits as
 * it progresses. These are the `ON_*` subset of extension action points —
 * fire-and-forget notifications that cannot modify the deployment.
 */
export type DeploymentEventType =
  | "ON_DEPLOYMENT_START"
  | "ON_DEPLOYMENT_STEP"
  | "ON_DEPLOYMENT_BAKING"
  | "ON_DEPLOYMENT_COMPLETE"
  | "ON_DEPLOYMENT_ROLLED_BACK";

/**
 * The payload AppConfig sends when it invokes the host function at a
 * deployment action point (the extension invocation payload, verbatim).
 */
export interface DeploymentEventRecord {
  /** Unique id of this extension invocation. */
  InvocationId: string;
  /** The action point that fired, e.g. `"OnDeploymentStart"`. */
  Type: string;
  /** The application the deployment belongs to. */
  Application?: { Id?: string; Name?: string };
  /** The environment being deployed to. */
  Environment?: { Id?: string; Name?: string };
  /** The configuration profile being deployed. */
  ConfigurationProfile?: { Id?: string; Name?: string };
  /** The deployment's number within the environment. */
  DeploymentNumber?: number;
  /** Description of the deployment. */
  Description?: string;
  /** Parameter values supplied by the extension association. */
  Parameters?: Record<string, string>;
}

export interface DeploymentEventSourceProps {
  /**
   * The deployment action points to subscribe to.
   * @default all five `ON_DEPLOYMENT_*` action points
   */
  events?: DeploymentEventType[];
}

type DeploymentEventsHandler<Req> = (
  events: Stream.Stream<DeploymentEventRecord>,
) => Effect.Effect<void, never, Req>;

/**
 * Subscribe an Effect handler to AppConfig deployment events for an
 * {@link Application} or {@link Environment}.
 *
 * At deploy time this provisions an AppConfig extension targeting the host
 * function (plus the IAM role AppConfig assumes to invoke it) and associates
 * the extension with the target resource. At runtime the handler receives
 * each deployment notification as a {@link DeploymentEventRecord}.
 *
 * @param target The application or environment whose deployments to observe.
 * @param props Optional event-source configuration (which action points).
 * @param process The handler invoked with a stream of deployment events.
 *
 * @example
 * ```typescript
 * yield* AppConfig.consumeDeploymentEvents(env, (events) =>
 *   events.pipe(
 *     Stream.runForEach((event) =>
 *       Effect.log(`${event.Type}: deployment ${event.DeploymentNumber}`),
 *     ),
 *   ),
 * );
 * ```
 *
 * @example Only completed deployments
 * ```typescript
 * yield* AppConfig.consumeDeploymentEvents(
 *   env,
 *   { events: ["ON_DEPLOYMENT_COMPLETE"] },
 *   (events) =>
 *     events.pipe(Stream.runForEach((event) => Effect.log(event.Type))),
 * );
 * ```
 */
export function consumeDeploymentEvents<Req = never>(
  target: Application | Environment,
  process: DeploymentEventsHandler<Req>,
): Effect.Effect<void, never, DeploymentEventSource>;
export function consumeDeploymentEvents<Req = never>(
  target: Application | Environment,
  props: DeploymentEventSourceProps,
  process: DeploymentEventsHandler<Req>,
): Effect.Effect<void, never, DeploymentEventSource>;
export function consumeDeploymentEvents<Req = never>(
  target: Application | Environment,
  propsOrProcess: DeploymentEventSourceProps | DeploymentEventsHandler<Req>,
  maybeProcess?: DeploymentEventsHandler<Req>,
): Effect.Effect<void, never, DeploymentEventSource> {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as DeploymentEventSourceProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  return DeploymentEventSource.use((source) => source(target, props, process));
}

/**
 * Event source connecting AppConfig deployment notifications to the hosting
 * compute. The contract is a `Binding.Service`; the Lambda implementation
 * layer is `Lambda.AppConfigDeploymentEventSource` (extension + association +
 * invoke role at deploy time, payload dispatch at runtime). Consume it
 * through the {@link consumeDeploymentEvents} helper.
 * @binding
 * @section Consuming Deployment Events
 * @example React to Deployments of an Environment
 * ```typescript
 * export default MyFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const app = yield* AppConfig.Application("App", {});
 *     const env = yield* AppConfig.Environment("Env", {
 *       applicationId: app.applicationId,
 *     });
 *
 *     yield* AppConfig.consumeDeploymentEvents(env, (events) =>
 *       events.pipe(
 *         Stream.runForEach((event) =>
 *           Effect.log(`deployment event: ${event.Type}`),
 *         ),
 *       ),
 *     );
 *   }).pipe(Effect.provide(Lambda.AppConfigDeploymentEventSource)),
 * );
 * ```
 */
export interface DeploymentEventSource extends Binding.Service<
  DeploymentEventSource,
  "AWS.AppConfig.DeploymentEventSource",
  DeploymentEventSourceService
> {}

export const DeploymentEventSource = Binding.Service<DeploymentEventSource>(
  "AWS.AppConfig.DeploymentEventSource",
);

export type DeploymentEventSourceService = <Req = never>(
  target: Application | Environment,
  props: DeploymentEventSourceProps,
  process: (
    events: Stream.Stream<DeploymentEventRecord>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;
