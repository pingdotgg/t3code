import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Namespace from "../../Namespace.ts";
import type { Application } from "../AppConfig/Application.ts";
import {
  DeploymentEventSource as AppConfigDeploymentEventSourceContract,
  type DeploymentEventRecord,
  type DeploymentEventSourceProps,
  type DeploymentEventSourceService,
  type DeploymentEventType,
} from "../AppConfig/DeploymentEventSource.ts";
import type { Environment } from "../AppConfig/Environment.ts";
import { Extension } from "../AppConfig/Extension.ts";
import { ExtensionAssociation } from "../AppConfig/ExtensionAssociation.ts";
import { Role } from "../IAM/Role.ts";
import * as Lambda from "./Function.ts";

const ALL_DEPLOYMENT_EVENTS: DeploymentEventType[] = [
  "ON_DEPLOYMENT_START",
  "ON_DEPLOYMENT_STEP",
  "ON_DEPLOYMENT_BAKING",
  "ON_DEPLOYMENT_COMPLETE",
  "ON_DEPLOYMENT_ROLLED_BACK",
];

/** Short, deterministic suffix distinguishing subscriptions by action-point set. */
const eventSetSuffix = (events: DeploymentEventType[]): string =>
  [...events]
    .sort()
    .map((event) =>
      event
        .replace("ON_DEPLOYMENT_", "")
        .toLowerCase()
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(""),
    )
    .join("");

/**
 * Narrow an arbitrary Lambda invocation payload to an AppConfig extension
 * deployment notification.
 */
export const isAppConfigDeploymentEvent = (
  event: any,
): event is DeploymentEventRecord =>
  typeof event?.InvocationId === "string" &&
  typeof event?.Type === "string" &&
  typeof event?.Application === "object";

const isEnvironment = (
  target: Application | Environment,
): target is Environment => target.Type === "AWS.AppConfig.Environment";

/**
 * Lambda runtime implementation for `AWS.AppConfig.consumeDeploymentEvents(...)`.
 *
 * This layer does two things:
 *
 * 1. At deploy time it provisions an AppConfig {@link Extension} whose
 *    actions invoke the current Lambda function at the subscribed deployment
 *    action points, the IAM role AppConfig assumes to perform the
 *    invocation, and an {@link ExtensionAssociation} attaching the extension
 *    to the target application or environment.
 * 2. At runtime it narrows incoming invocations to AppConfig deployment
 *    notifications for the bound target and forwards them into the supplied
 *    handler as a typed `DeploymentEventRecord` stream.
 * @binding
 * @section Consuming Deployment Events
 * @example Record Completed Deployments
 * ```typescript
 * yield* AppConfig.consumeDeploymentEvents(
 *   env,
 *   { events: ["ON_DEPLOYMENT_COMPLETE"] },
 *   (events) =>
 *     events.pipe(
 *       Stream.runForEach((event) =>
 *         Effect.log(`deployment ${event.DeploymentNumber} completed`),
 *       ),
 *     ),
 * );
 * ```
 */
export const AppConfigDeploymentEventSource = Layer.effect(
  AppConfigDeploymentEventSourceContract,
  // The impl resolves plan-time services (Role, Extension, Association)
  // whereas DeploymentEventSourceService erases the requirement channel to
  // `never`.
  // @effect-diagnostics-next-line missingEffectContext:off
  Effect.gen(function* () {
    const host = yield* Lambda.Function;
    const InvokeRole = yield* Role;
    const DeploymentExtension = yield* Extension;
    const DeploymentExtensionAssociation = yield* ExtensionAssociation;

    return Effect.fn(function* <Req = never>(
      target: Application | Environment,
      props: DeploymentEventSourceProps,
      process: (
        events: Stream.Stream<DeploymentEventRecord>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      const events = props.events ?? ALL_DEPLOYMENT_EVENTS;
      const suffix = eventSetSuffix(events);

      // Resolving the target's id also registers it on the host environment;
      // re-yield per invocation inside the listener below.
      const TargetId = yield* isEnvironment(target)
        ? target.environmentId
        : target.applicationId;

      // Deploy-time: provision the invoke role, the extension whose actions
      // call this function at each subscribed action point, and the
      // association binding the extension to the target. Skipped once running
      // inside the deployed Function (the global guard), where the only work
      // is registering the runtime handler below. Namespaced under the host
      // so the sub-resources' logical identity is stable per host function.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            // NB: hyphenated logical ids only — the id lands in the
            // `alchemy::id` tag value, and IAM/AppConfig tag values reject
            // `(`, `)` and `,`.
            const role = yield* InvokeRole(
              `${target.LogicalId}-${suffix}-InvokeRole`,
              {
                assumeRolePolicyDocument: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Principal: { Service: "appconfig.amazonaws.com" },
                      Action: ["sts:AssumeRole"],
                    },
                  ],
                },
                inlinePolicies: {
                  InvokeFunction: {
                    Version: "2012-10-17",
                    Statement: [
                      {
                        Effect: "Allow",
                        Action: ["lambda:InvokeFunction"],
                        Resource: [host.functionArn as any],
                      },
                    ],
                  },
                },
              },
            );

            const extension = yield* DeploymentExtension(
              `${target.LogicalId}-${suffix}-DeploymentEvents`,
              {
                description: `Deployment notifications for ${target.LogicalId} -> ${host.LogicalId}`,
                actions: Object.fromEntries(
                  events.map((event) => [
                    event,
                    [
                      {
                        name: event,
                        uri: host.functionArn as any,
                        roleArn: role.roleArn as any,
                      },
                    ],
                  ]),
                ),
              },
            );

            yield* DeploymentExtensionAssociation(
              `${target.LogicalId}-${suffix}-DeploymentEventsAssociation`,
              {
                extensionIdentifier: extension.extensionId as any,
                resourceIdentifier: (isEnvironment(target)
                  ? target.environmentArn
                  : target.applicationArn) as any,
              },
            );
          }),
        );
      }

      yield* host.listen(
        Effect.gen(function* () {
          const targetId = yield* TargetId;
          const subscribed = new Set(
            events.map((event) =>
              // "ON_DEPLOYMENT_START" -> "OnDeploymentStart" (payload `Type`)
              event
                .toLowerCase()
                .split("_")
                .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                .join(""),
            ),
          );
          return (event: any) => {
            if (
              isAppConfigDeploymentEvent(event) &&
              subscribed.has(event.Type) &&
              (isEnvironment(target)
                ? event.Environment?.Id === targetId
                : event.Application?.Id === targetId)
            ) {
              return process(Stream.succeed(event)).pipe(Effect.orDie);
            }
          };
        }),
      );
    }) as DeploymentEventSourceService;
  }),
);
