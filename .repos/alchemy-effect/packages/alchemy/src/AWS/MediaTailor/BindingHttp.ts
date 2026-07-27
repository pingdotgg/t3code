import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { PlaybackConfiguration } from "./PlaybackConfiguration.ts";

/**
 * Shared HTTP scaffolding for the AWS Elemental MediaTailor runtime
 * bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation, the identifier resolver,
 * and the IAM action list is boilerplate.
 */

/**
 * Builder for account-level MediaTailor bindings (channel assembly control
 * and reads). Channel/program names are runtime request parameters, so the
 * deploy-time half grants `iamActions` on `Resource: ["*"]` and the runtime
 * callable passes the request through unchanged.
 */
export const makeMediaTailorHttpBinding = <I, A, E, R>(options: {
  /** Short capability name used in the binding sid and runtime span. */
  capability: string;
  /** IAM actions granted on `Resource: ["*"]`. */
  iamActions: readonly string[];
  /** The distilled operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.MediaTailor.${options.capability}())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  // Channel-assembly resource names are runtime parameters;
                  // their ARNs are unknowable at deploy time.
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.MediaTailor.${options.capability}`)(function* (
        request: I,
      ) {
        return yield* op(request);
      });
    });
  });

/**
 * Builder for bindings scoped to a {@link PlaybackConfiguration} (the
 * prefetch-schedule data plane). The runtime callable injects the bound
 * configuration's name as `PlaybackConfigurationName`, and the deploy-time
 * half grants `iamActions` on the configuration's ARN and the derived
 * `…:prefetchSchedule/{name}/*` ARN space.
 */
export const makeMediaTailorPlaybackHttpBinding = <
  I extends { PlaybackConfigurationName: string },
  A,
  E,
  R,
>(options: {
  /** Short capability name used in the binding sid and runtime span. */
  capability: string;
  /** IAM actions granted on the configuration + prefetch-schedule ARNs. */
  iamActions: readonly string[];
  /**
   * The distilled operation; `PlaybackConfigurationName` is injected from
   * the bound configuration.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (config: PlaybackConfiguration) {
      const name = yield* config.name;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.MediaTailor.${options.capability}(${config}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: [
                    Output.interpolate`${config.playbackConfigurationArn}`,
                    // Prefetch schedules live in a sibling ARN space:
                    // arn:…:prefetchSchedule/{configurationName}/{name}
                    Output.map(
                      config.playbackConfigurationArn,
                      (arn) =>
                        `${arn.replace(":playbackConfiguration/", ":prefetchSchedule/")}/*`,
                    ),
                    // ListPrefetchSchedules is authorized against the bare
                    // account/region wildcard `…:prefetchSchedule/*` (the
                    // configuration name is not part of the authorization
                    // resource), so every prefetch binding also grants it.
                    Output.map(config.playbackConfigurationArn, (arn) =>
                      arn.replace(
                        /:playbackConfiguration\/.*$/,
                        ":prefetchSchedule/*",
                      ),
                    ),
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.MediaTailor.${options.capability}(${config.LogicalId})`,
      )(function* (request: Omit<I, "PlaybackConfigurationName">) {
        return yield* op({
          ...request,
          PlaybackConfigurationName: yield* name,
        } as I);
      });
    });
  });
